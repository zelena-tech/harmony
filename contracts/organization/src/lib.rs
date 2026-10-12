//! # Harmony Organization Contract
//!
//! Contrato central de Harmony. Uno por empresa.
//! Gestiona miembros, plantillas de actividad, tareas,
//! períodos de recompensa y distribución de fondos en Stellar.
//!
//! ## Modelo de roles
//! - Owner      → control total, único por contrato
//! - Supervisor → gestión de tareas y períodos
//! - Worker     → solo puede completar sus propias tareas y reclamar recompensas
//!
//! ## Garantías de seguridad
//!  1. `require_auth()` en TODA operación que modifica estado
//!  2. Init guard — imposible re-inicializar
//!  3. Máquina de estados estricta (Open → Closed → Distributed)
//!  4. Patrón CEI en `claim_reward` — marcar claimed ANTES de transferir
//!  5. Aritmética con overflow-checks en profile release
//!  6. Multiplier de puntos acotado [0%, 200%] — no permite puntos infinitos
//!  7. Pause de emergencia — Owner detiene TODO sin re-deploy
//!  8. TTL extendido — datos no expiran del ledger en un año
//!  9. Worker solo puede completar SUS tareas, nadie más
//! 10. Double-claim imposible — flag `claimed` se escribe antes del transfer
//! 11. [FIX] `review_task` rechaza aprobaciones sobre períodos ya Distributed
//! 12. [FIX] Supervisor no puede asignar rol Supervisor ni degradar/reactivar Supervisors
//! 13. [FIX] `recover_undistributed` pone fund_amount = 0 tras la transferencia
//! 14. [NEW] `claimed_amount` acumulado por período — auditoría on-chain
//! 15. [NEW] `sweep_expired_claims` — Owner recupera dust tras 1 año
//! 16. [FIX] Supervisor no puede reactivar un Worker que el Owner desactivó

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, panic_with_error,
    token, Address, Env, String, Symbol,
};

// ─── TTL ─────────────────────────────────────────────────────────────────────
const DAY_IN_LEDGERS:     u32 = 17_280;
const INSTANCE_TTL:       u32 = 30  * DAY_IN_LEDGERS;
const MAX_TTL:            u32 = 365 * DAY_IN_LEDGERS;

// Tiempo máximo para que un worker reclame su recompensa (1 año en segundos).
// Pasado este plazo el Owner puede recuperar el dust vía sweep_expired_claims.
const CLAIM_EXPIRY_SECS:  u64 = 365 * 24 * 60 * 60;

// Basis points base para multiplicador de puntos (100% = 10_000 bp)
const BP_BASE:            u64 = 10_000;
const MAX_MULTIPLIER:     u32 = 20_000; // techo: 200%

// ─── Errores ─────────────────────────────────────────────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum OrgError {
    AlreadyInitialized   = 1,
    NotInitialized       = 2,
    Unauthorized         = 3,   // rol insuficiente
    ContractPaused       = 4,
    MemberNotFound       = 5,
    MemberInactive       = 6,
    CannotRemoveOwner    = 7,
    TemplateNotFound     = 8,
    TemplateInactive     = 9,
    TaskNotFound         = 10,
    InvalidTaskState     = 11,  // transición de estado inválida
    PeriodNotFound       = 12,
    InvalidPeriodState   = 13,  // transición de período inválida
    AlreadyClaimed       = 14,
    NoRewardsToClaim     = 15,
    InvalidAmount        = 16,  // monto ≤ 0 o inválido
    ArithmeticOverflow   = 17,
    WorkerNotMember      = 18,
    PeriodEndBeforeStart = 19,
    ClaimsExpired        = 20,  // [NEW] plazo de reclamo vencido
    ClaimsNotExpired     = 21,  // [NEW] plazo de reclamo aún vigente
}

// ─── Tipos de datos ───────────────────────────────────────────────────────────

#[derive(Clone, PartialEq, Debug)]
#[contracttype]
pub enum Role {
    Owner,
    Supervisor,
    Worker,
}

#[derive(Clone)]
#[contracttype]
pub struct MemberInfo {
    pub role:      Role,
    pub active:    bool,
    pub joined_at: u64, // ledger timestamp
}

/// Estado del período — solo avanza, nunca retrocede
#[derive(Clone, PartialEq, Debug)]
#[contracttype]
pub enum PeriodState {
    Open,        // aceptando tareas
    Closed,      // cerrado, pendiente distribución
    Distributed, // fondo distribuido, workers pueden reclamar
}

#[derive(Clone)]
#[contracttype]
pub struct PeriodInfo {
    pub state:          PeriodState,
    pub start_time:     u64,
    pub end_time:       u64,
    pub fund_amount:    i128, // tokens depositados (en unidades del activo)
    pub total_points:   u64,  // suma de puntos aprobados de todos los workers
    pub claimed_amount: i128, // [NEW] total acumulado ya reclamado (auditoría)
    pub distributed_at: u64,  // [NEW] timestamp de distribución (0 = no distribuido)
}

/// Estado de la tarea — solo avanza, nunca retrocede
#[derive(Clone, PartialEq, Debug)]
#[contracttype]
pub enum TaskState {
    Assigned,  // asignada al worker
    Completed, // worker marcó como hecha, esperando revisión
    Approved,  // supervisor aprobó → puntos acreditados
    Rejected,  // supervisor rechazó → sin puntos
    Skipped,   // supervisor saltó → sin efecto
}

#[derive(Clone)]
#[contracttype]
pub struct TaskInfo {
    pub worker:       Address,
    pub template_id:  u32,
    pub period_id:    u32,
    pub state:        TaskState,
    pub base_points:  u32,    // puntos del template al momento de asignación
    pub final_points: u32,    // puntos reales tras aplicar multiplier
    pub evidence_url: String, // URL de evidencia subida por el worker
    pub created_at:   u64,
    pub completed_at: u64,    // 0 si aún no completada
}

#[derive(Clone)]
#[contracttype]
pub struct ActivityTemplate {
    pub name:        String,
    pub base_points: u32,
    pub active:      bool,
}

/// Estadísticas del worker para un período específico
#[derive(Clone)]
#[contracttype]
pub struct WorkerStats {
    pub tasks_assigned:  u32,
    pub tasks_completed: u32,
    pub tasks_approved:  u32,
    pub tasks_rejected:  u32,
    pub tasks_skipped:   u32,
    pub total_points:    u64,
    pub claimed:         bool, // true después de reclamar recompensa
}

impl WorkerStats {
    fn zero() -> Self {
        WorkerStats {
            tasks_assigned:  0,
            tasks_completed: 0,
            tasks_approved:  0,
            tasks_rejected:  0,
            tasks_skipped:   0,
            total_points:    0,
            claimed:         false,
        }
    }
}

// ─── Claves de storage ────────────────────────────────────────────────────────
#[contracttype]
pub enum DataKey {
    // Instance (datos del contrato, compartidos)
    Owner,
    RewardAsset,
    Paused,
    TaskCount,
    TemplateCount,
    PeriodCount,
    // Persistent (por entidad, larga duración)
    Member(Address),
    Template(u32),
    Task(u32),
    Period(u32),
    WorkerStats(u32, Address), // (period_id, worker)
}

// ─── Contrato ─────────────────────────────────────────────────────────────────
#[contract]
pub struct OrgContract;

#[contractimpl]
impl OrgContract {

    // ═══════════════════════════════════════════════════════════════════════════
    // INICIALIZACIÓN
    // ═══════════════════════════════════════════════════════════════════════════

    /// Inicializa la organización. Solo puede llamarse UNA vez.
    ///
    /// - `owner`        : dirección Stellar de la empresa (rol Owner)
    /// - `reward_asset` : dirección del activo de recompensa (ej. USDC en Stellar)
    pub fn initialize(env: Env, owner: Address, reward_asset: Address) {
        if env.storage().instance().has(&DataKey::Owner) {
            panic_with_error!(&env, OrgError::AlreadyInitialized);
        }

        owner.require_auth();

        env.storage().instance().set(&DataKey::Owner,         &owner);
        env.storage().instance().set(&DataKey::RewardAsset,   &reward_asset);
        env.storage().instance().set(&DataKey::Paused,        &false);
        env.storage().instance().set(&DataKey::TaskCount,     &0u32);
        env.storage().instance().set(&DataKey::TemplateCount, &0u32);
        env.storage().instance().set(&DataKey::PeriodCount,   &0u32);
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);

        let owner_info = MemberInfo {
            role:      Role::Owner,
            active:    true,
            joined_at: env.ledger().timestamp(),
        };
        Self::set_member(&env, &owner, &owner_info);

        env.events().publish(
            (Symbol::new(&env, "org_init"),),
            (&owner, &reward_asset),
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONTROL DE EMERGENCIA
    // ═══════════════════════════════════════════════════════════════════════════

    /// Pausa todas las operaciones (excepto unpause). Solo Owner.
    pub fn pause(env: Env, caller: Address) {
        caller.require_auth();
        Self::check_role_owner(&env, &caller);

        env.storage().instance().set(&DataKey::Paused, &true);
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);

        env.events().publish((Symbol::new(&env, "emergency_pause"),), caller);
    }

    /// Reanuda operaciones. Solo Owner.
    pub fn unpause(env: Env, caller: Address) {
        caller.require_auth();
        Self::check_role_owner(&env, &caller);

        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);

        env.events().publish((Symbol::new(&env, "emergency_unpause"),), caller);
    }

    /// Transfiere ownership. Requiere firma de AMBAS direcciones.
    pub fn transfer_ownership(env: Env, current_owner: Address, new_owner: Address) {
        Self::check_not_paused(&env);
        current_owner.require_auth();
        new_owner.require_auth();
        Self::check_role_owner(&env, &current_owner);

        let old_info = MemberInfo {
            role:      Role::Supervisor,
            active:    true,
            joined_at: env.ledger().timestamp(),
        };
        Self::set_member(&env, &current_owner, &old_info);

        let new_info = MemberInfo {
            role:      Role::Owner,
            active:    true,
            joined_at: env.ledger().timestamp(),
        };
        Self::set_member(&env, &new_owner, &new_info);
        env.storage().instance().set(&DataKey::Owner, &new_owner);
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);

        env.events().publish(
            (Symbol::new(&env, "ownership_transferred"),),
            (&current_owner, &new_owner),
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GESTIÓN DE MIEMBROS
    // ═══════════════════════════════════════════════════════════════════════════

    /// Agrega o actualiza un miembro.
    /// - Owner puede agregar Supervisors y Workers
    /// - Supervisor solo puede agregar Workers NUEVOS (no puede degradar Supervisors)
    /// - Nadie puede asignar rol Owner (solo transfer_ownership)
    pub fn add_member(env: Env, caller: Address, member: Address, role: Role) {
        Self::check_not_paused(&env);
        caller.require_auth();
        let caller_role = Self::get_role_or_panic(&env, &caller);

        // Solo Owner y Supervisor pueden agregar miembros
        if caller_role == Role::Worker {
            panic_with_error!(&env, OrgError::Unauthorized);
        }

        // Supervisors solo pueden agregar Workers
        if caller_role == Role::Supervisor && role != Role::Worker {
            panic_with_error!(&env, OrgError::Unauthorized);
        }

        // Nadie puede asignar rol Owner directamente (solo transfer_ownership)
        if role == Role::Owner {
            panic_with_error!(&env, OrgError::Unauthorized);
        }

        // [FIX] Supervisor no puede modificar miembros existentes con rol >= Supervisor,
        // ni reactivar Workers que el Owner haya desactivado explícitamente.
        // Solo el Owner puede cambiar el estado de Supervisors, Owners o miembros inactivos.
        if caller_role == Role::Supervisor {
            if let Some(existing) = env.storage()
                .persistent()
                .get::<DataKey, MemberInfo>(&DataKey::Member(member.clone()))
            {
                if existing.role != Role::Worker || !existing.active {
                    panic_with_error!(&env, OrgError::Unauthorized);
                }
            }
        }

        let joined_at = env.storage()
            .persistent()
            .get::<DataKey, MemberInfo>(&DataKey::Member(member.clone()))
            .map(|m| m.joined_at)
            .unwrap_or_else(|| env.ledger().timestamp());

        let info = MemberInfo { role: role.clone(), active: true, joined_at };
        Self::set_member(&env, &member, &info);

        env.events().publish(
            (Symbol::new(&env, "member_added"), member),
            role,
        );
    }

    /// Desactiva un miembro. Solo Owner.
    /// El Owner no puede removerse a sí mismo.
    pub fn remove_member(env: Env, caller: Address, member: Address) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_role_owner(&env, &caller);

        let info: MemberInfo = env.storage()
            .persistent()
            .get(&DataKey::Member(member.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::MemberNotFound));

        if info.role == Role::Owner {
            panic_with_error!(&env, OrgError::CannotRemoveOwner);
        }

        let updated = MemberInfo { active: false, ..info };
        Self::set_member(&env, &member, &updated);

        env.events().publish((Symbol::new(&env, "member_removed"),), member);
    }

    pub fn get_member(env: Env, member: Address) -> MemberInfo {
        env.storage()
            .persistent()
            .get(&DataKey::Member(member))
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::MemberNotFound))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PLANTILLAS DE ACTIVIDAD
    // ═══════════════════════════════════════════════════════════════════════════

    /// Crea una plantilla de actividad (tipo de tarea). Supervisor+.
    pub fn create_template(env: Env, caller: Address, name: String, base_points: u32) -> u32 {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_role_supervisor_or_owner(&env, &caller);

        if base_points == 0 {
            panic_with_error!(&env, OrgError::InvalidAmount);
        }

        let count: u32 = env.storage().instance()
            .get(&DataKey::TemplateCount)
            .unwrap_or(0);
        let new_id = count
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::ArithmeticOverflow));

        let template = ActivityTemplate { name: name.clone(), base_points, active: true };
        env.storage().persistent().set(&DataKey::Template(new_id), &template);
        env.storage().persistent().extend_ttl(&DataKey::Template(new_id), MAX_TTL, MAX_TTL);
        env.storage().instance().set(&DataKey::TemplateCount, &new_id);
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);

        env.events().publish(
            (Symbol::new(&env, "template_created"), new_id),
            (name, base_points),
        );

        new_id
    }

    /// Desactiva una plantilla. Supervisor+.
    pub fn deactivate_template(env: Env, caller: Address, template_id: u32) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_role_supervisor_or_owner(&env, &caller);

        let mut t: ActivityTemplate = env.storage()
            .persistent()
            .get(&DataKey::Template(template_id))
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::TemplateNotFound));

        t.active = false;
        env.storage().persistent().set(&DataKey::Template(template_id), &t);

        env.events().publish(
            (Symbol::new(&env, "template_deactivated"),), template_id,
        );
    }

    pub fn get_template(env: Env, template_id: u32) -> ActivityTemplate {
        env.storage()
            .persistent()
            .get(&DataKey::Template(template_id))
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::TemplateNotFound))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PERÍODOS
    // ═══════════════════════════════════════════════════════════════════════════

    /// Abre un nuevo período de recompensa. Supervisor+.
    pub fn open_period(env: Env, caller: Address, start_time: u64, end_time: u64) -> u32 {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_role_supervisor_or_owner(&env, &caller);

        if end_time <= start_time {
            panic_with_error!(&env, OrgError::PeriodEndBeforeStart);
        }

        let count: u32 = env.storage().instance()
            .get(&DataKey::PeriodCount)
            .unwrap_or(0);
        let new_id = count
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::ArithmeticOverflow));

        let period = PeriodInfo {
            state:          PeriodState::Open,
            start_time,
            end_time,
            fund_amount:    0,
            total_points:   0,
            claimed_amount: 0,
            distributed_at: 0,
        };
        env.storage().persistent().set(&DataKey::Period(new_id), &period);
        env.storage().persistent().extend_ttl(&DataKey::Period(new_id), MAX_TTL, MAX_TTL);
        env.storage().instance().set(&DataKey::PeriodCount, &new_id);
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);

        env.events().publish(
            (Symbol::new(&env, "period_opened"), new_id),
            (start_time, end_time),
        );

        new_id
    }

    /// Cierra un período. Después de cerrar no se pueden aprobar más tareas.
    /// Supervisor+. Solo puede pasar de Open → Closed.
    pub fn close_period(env: Env, caller: Address, period_id: u32) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_role_supervisor_or_owner(&env, &caller);

        let mut period: PeriodInfo = Self::get_period_or_panic(&env, period_id);

        if period.state != PeriodState::Open {
            panic_with_error!(&env, OrgError::InvalidPeriodState);
        }

        period.state = PeriodState::Closed;
        env.storage().persistent().set(&DataKey::Period(period_id), &period);

        env.events().publish(
            (Symbol::new(&env, "period_closed"),), period_id,
        );
    }

    pub fn get_period(env: Env, period_id: u32) -> PeriodInfo {
        Self::get_period_or_panic(&env, period_id)
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TAREAS
    // ═══════════════════════════════════════════════════════════════════════════

    /// Asigna una tarea a un worker. Supervisor+.
    pub fn create_task(
        env:         Env,
        caller:      Address,
        worker:      Address,
        template_id: u32,
        period_id:   u32,
    ) -> u32 {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_role_supervisor_or_owner(&env, &caller);

        let period = Self::get_period_or_panic(&env, period_id);
        if period.state != PeriodState::Open {
            panic_with_error!(&env, OrgError::InvalidPeriodState);
        }

        let template: ActivityTemplate = env.storage()
            .persistent()
            .get(&DataKey::Template(template_id))
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::TemplateNotFound));
        if !template.active {
            panic_with_error!(&env, OrgError::TemplateInactive);
        }

        let member: MemberInfo = env.storage()
            .persistent()
            .get(&DataKey::Member(worker.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::WorkerNotMember));
        if !member.active {
            panic_with_error!(&env, OrgError::MemberInactive);
        }

        let count: u32 = env.storage().instance()
            .get(&DataKey::TaskCount)
            .unwrap_or(0);
        let new_id = count
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::ArithmeticOverflow));

        let task = TaskInfo {
            worker:       worker.clone(),
            template_id,
            period_id,
            state:        TaskState::Assigned,
            base_points:  template.base_points,
            final_points: 0,
            evidence_url: String::from_str(&env, ""),
            created_at:   env.ledger().timestamp(),
            completed_at: 0,
        };
        env.storage().persistent().set(&DataKey::Task(new_id), &task);
        env.storage().persistent().extend_ttl(&DataKey::Task(new_id), MAX_TTL, MAX_TTL);
        env.storage().instance().set(&DataKey::TaskCount, &new_id);
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);

        let stats_key = DataKey::WorkerStats(period_id, worker.clone());
        let mut stats: WorkerStats = env.storage().persistent()
            .get(&stats_key)
            .unwrap_or_else(WorkerStats::zero);
        stats.tasks_assigned = stats.tasks_assigned.saturating_add(1);
        env.storage().persistent().set(&stats_key, &stats);
        env.storage().persistent().extend_ttl(&stats_key, MAX_TTL, MAX_TTL);

        env.events().publish(
            (Symbol::new(&env, "task_created"), new_id),
            (&worker, template_id, period_id),
        );

        new_id
    }

    /// El worker marca su propia tarea como completada con evidencia.
    /// SEGURIDAD: solo el worker asignado puede completar su tarea.
    pub fn complete_task(env: Env, worker: Address, task_id: u32, evidence_url: String) {
        Self::check_not_paused(&env);
        worker.require_auth();

        let mut task: TaskInfo = env.storage()
            .persistent()
            .get(&DataKey::Task(task_id))
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::TaskNotFound));

        if task.worker != worker {
            panic_with_error!(&env, OrgError::Unauthorized);
        }

        if task.state != TaskState::Assigned {
            panic_with_error!(&env, OrgError::InvalidTaskState);
        }

        let period = Self::get_period_or_panic(&env, task.period_id);
        if period.state != PeriodState::Open {
            panic_with_error!(&env, OrgError::InvalidPeriodState);
        }

        task.state        = TaskState::Completed;
        task.evidence_url = evidence_url;
        task.completed_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Task(task_id), &task);

        let stats_key = DataKey::WorkerStats(task.period_id, worker.clone());
        let mut stats: WorkerStats = env.storage().persistent()
            .get(&stats_key)
            .unwrap_or_else(WorkerStats::zero);
        stats.tasks_completed = stats.tasks_completed.saturating_add(1);
        env.storage().persistent().set(&stats_key, &stats);

        env.events().publish(
            (Symbol::new(&env, "task_completed"), task_id),
            worker,
        );
    }

    /// Supervisor revisa una tarea completada.
    ///
    /// `point_multiplier_bp`: multiplicador en basis points.
    /// - 10_000 = 100% (puntaje normal)
    /// - 12_000 = 120% (trabajo excelente)
    /// -  8_000 =  80% (trabajo con problemas)
    ///
    /// Máximo: 20_000 (200%) — techo duro, no se puede sobrepasar.
    ///
    /// [FIX] No permite aprobar tareas en períodos ya Distributed.
    /// Antes de la distribución (Open o Closed) la aprobación es válida.
    pub fn review_task(
        env:                 Env,
        caller:              Address,
        task_id:             u32,
        approved:            bool,
        point_multiplier_bp: u32,
    ) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_role_supervisor_or_owner(&env, &caller);

        let mut task: TaskInfo = env.storage()
            .persistent()
            .get(&DataKey::Task(task_id))
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::TaskNotFound));

        if task.state != TaskState::Completed {
            panic_with_error!(&env, OrgError::InvalidTaskState);
        }

        // [FIX] Obtener período temprano para validar su estado.
        // No se permiten aprobaciones sobre períodos ya Distributed: haría que
        // total_points crezca después de que algunos workers ya reclamaron,
        // rompiendo la proporcionalidad del fondo.
        let mut period = Self::get_period_or_panic(&env, task.period_id);
        if period.state == PeriodState::Distributed {
            panic_with_error!(&env, OrgError::InvalidPeriodState);
        }

        let stats_key = DataKey::WorkerStats(task.period_id, task.worker.clone());
        let mut stats: WorkerStats = env.storage().persistent()
            .get(&stats_key)
            .unwrap_or_else(WorkerStats::zero);

        if approved {
            // Acotar multiplier al máximo permitido (200%)
            let multiplier = point_multiplier_bp.min(MAX_MULTIPLIER) as u64;

            let final_pts = (task.base_points as u64)
                .checked_mul(multiplier)
                .unwrap_or_else(|| panic_with_error!(&env, OrgError::ArithmeticOverflow))
                .checked_div(BP_BASE)
                .unwrap_or_else(|| panic_with_error!(&env, OrgError::ArithmeticOverflow))
                as u32;

            task.final_points = final_pts;
            task.state        = TaskState::Approved;

            stats.tasks_approved = stats.tasks_approved.saturating_add(1);
            stats.total_points   = stats.total_points
                .checked_add(final_pts as u64)
                .unwrap_or_else(|| panic_with_error!(&env, OrgError::ArithmeticOverflow));

            period.total_points = period.total_points
                .checked_add(final_pts as u64)
                .unwrap_or_else(|| panic_with_error!(&env, OrgError::ArithmeticOverflow));
            env.storage().persistent().set(&DataKey::Period(task.period_id), &period);

        } else {
            task.state = TaskState::Rejected;
            stats.tasks_rejected = stats.tasks_rejected.saturating_add(1);
        }

        env.storage().persistent().set(&DataKey::Task(task_id), &task);
        env.storage().persistent().set(&stats_key, &stats);

        env.events().publish(
            (Symbol::new(&env, "task_reviewed"), task_id),
            (approved, task.final_points),
        );
    }

    /// Supervisor salta una tarea (no procede). Supervisor+.
    pub fn skip_task(env: Env, caller: Address, task_id: u32) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_role_supervisor_or_owner(&env, &caller);

        let mut task: TaskInfo = env.storage()
            .persistent()
            .get(&DataKey::Task(task_id))
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::TaskNotFound));

        if task.state != TaskState::Assigned {
            panic_with_error!(&env, OrgError::InvalidTaskState);
        }

        task.state = TaskState::Skipped;
        env.storage().persistent().set(&DataKey::Task(task_id), &task);

        let stats_key = DataKey::WorkerStats(task.period_id, task.worker.clone());
        let mut stats: WorkerStats = env.storage().persistent()
            .get(&stats_key)
            .unwrap_or_else(WorkerStats::zero);
        stats.tasks_skipped = stats.tasks_skipped.saturating_add(1);
        env.storage().persistent().set(&stats_key, &stats);

        env.events().publish((Symbol::new(&env, "task_skipped"),), task_id);
    }

    pub fn get_task(env: Env, task_id: u32) -> TaskInfo {
        env.storage()
            .persistent()
            .get(&DataKey::Task(task_id))
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::TaskNotFound))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GESTIÓN DE FONDOS
    // ═══════════════════════════════════════════════════════════════════════════

    /// Deposita tokens al fondo del período.
    /// Supervisor+. Período debe ser Open o Closed (no Distributed).
    pub fn fund_period(env: Env, caller: Address, funder: Address, period_id: u32, amount: i128) {
        Self::check_not_paused(&env);
        caller.require_auth();
        funder.require_auth();
        Self::check_role_supervisor_or_owner(&env, &caller);

        if amount <= 0 {
            panic_with_error!(&env, OrgError::InvalidAmount);
        }

        let mut period = Self::get_period_or_panic(&env, period_id);
        if period.state == PeriodState::Distributed {
            panic_with_error!(&env, OrgError::InvalidPeriodState);
        }

        let asset = Self::get_reward_asset_internal(&env);
        token::Client::new(&env, &asset)
            .transfer(&funder, &env.current_contract_address(), &amount);

        period.fund_amount = period.fund_amount
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::ArithmeticOverflow));
        env.storage().persistent().set(&DataKey::Period(period_id), &period);

        env.events().publish(
            (Symbol::new(&env, "period_funded"), period_id),
            (&funder, amount),
        );
    }

    /// Marca el período como Distribuido. Solo Owner.
    /// Después de esto, los workers pueden reclamar con `claim_reward`.
    /// Período debe estar Closed con fondo > 0.
    pub fn distribute_rewards(env: Env, caller: Address, period_id: u32) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_role_owner(&env, &caller);

        let mut period = Self::get_period_or_panic(&env, period_id);

        if period.state != PeriodState::Closed {
            panic_with_error!(&env, OrgError::InvalidPeriodState);
        }
        if period.fund_amount <= 0 {
            panic_with_error!(&env, OrgError::InvalidAmount);
        }

        period.state          = PeriodState::Distributed;
        // .max(1): garantiza que distributed_at > 0 incluso en entornos de test
        // donde el timestamp de ledger puede ser 0. En mainnet (Stellar ≥ 2015)
        // el timestamp siempre es >> 1, por lo que .max(1) no tiene efecto práctico.
        period.distributed_at = env.ledger().timestamp().max(1);
        env.storage().persistent().set(&DataKey::Period(period_id), &period);

        env.events().publish(
            (Symbol::new(&env, "rewards_distributed"), period_id),
            (period.fund_amount, period.total_points),
        );
    }

    /// Worker reclama su recompensa para un período Distributed.
    ///
    /// ## Patrón CEI (Check-Effects-Interactions) — anti re-entrancy:
    /// 1. CHECK     — verificar estado, no claimed, puntos > 0, plazo vigente
    /// 2. EFFECT    — marcar `claimed = true` y actualizar `claimed_amount`
    ///                ANTES de la transferencia
    /// 3. INTERACT  — transferir tokens
    pub fn claim_reward(env: Env, worker: Address, period_id: u32) {
        Self::check_not_paused(&env);
        worker.require_auth();

        let member: MemberInfo = env.storage()
            .persistent()
            .get(&DataKey::Member(worker.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::WorkerNotMember));
        if !member.active {
            panic_with_error!(&env, OrgError::MemberInactive);
        }

        // ══ CHECK ════════════════════════════════════════════════════════════
        let mut period = Self::get_period_or_panic(&env, period_id);
        if period.state != PeriodState::Distributed {
            panic_with_error!(&env, OrgError::InvalidPeriodState);
        }
        if period.fund_amount <= 0 || period.total_points == 0 {
            panic_with_error!(&env, OrgError::NoRewardsToClaim);
        }

        // [NEW] Verificar que el plazo de reclamo no haya vencido
        if period.distributed_at > 0
            && env.ledger().timestamp() > period.distributed_at
                .saturating_add(CLAIM_EXPIRY_SECS)
        {
            panic_with_error!(&env, OrgError::ClaimsExpired);
        }

        let stats_key = DataKey::WorkerStats(period_id, worker.clone());
        let mut stats: WorkerStats = env.storage()
            .persistent()
            .get(&stats_key)
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::NoRewardsToClaim));

        if stats.claimed {
            panic_with_error!(&env, OrgError::AlreadyClaimed);
        }
        if stats.total_points == 0 {
            panic_with_error!(&env, OrgError::NoRewardsToClaim);
        }

        // Calcular monto proporcional con u128 para evitar overflow intermedio
        let reward: i128 = (period.fund_amount as u128)
            .checked_mul(stats.total_points as u128)
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::ArithmeticOverflow))
            .checked_div(period.total_points as u128)
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::ArithmeticOverflow))
            as i128;

        if reward <= 0 {
            panic_with_error!(&env, OrgError::NoRewardsToClaim);
        }

        // ══ EFFECT — escribir ANTES del transfer (CEI pattern) ═══════════════
        stats.claimed = true;
        env.storage().persistent().set(&stats_key, &stats);

        // [NEW] Actualizar claimed_amount en el período para auditoría
        period.claimed_amount = period.claimed_amount
            .checked_add(reward)
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::ArithmeticOverflow));
        env.storage().persistent().set(&DataKey::Period(period_id), &period);

        // ══ INTERACTION — transferir tokens al worker ═════════════════════════
        let asset = Self::get_reward_asset_internal(&env);
        token::Client::new(&env, &asset)
            .transfer(&env.current_contract_address(), &worker, &reward);

        env.events().publish(
            (Symbol::new(&env, "reward_claimed"), period_id),
            (&worker, reward, stats.total_points),
        );
    }

    /// Recupera fondo no distribuido de un período. Solo Owner.
    /// Útil si ningún worker tiene puntos y el período fue distribuido.
    ///
    /// [FIX] Pone fund_amount = 0 después de la transferencia para
    /// mantener el estado del contrato consistente.
    pub fn recover_undistributed(env: Env, caller: Address, period_id: u32, to: Address) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_role_owner(&env, &caller);

        let mut period = Self::get_period_or_panic(&env, period_id);
        if period.state != PeriodState::Distributed {
            panic_with_error!(&env, OrgError::InvalidPeriodState);
        }
        // Solo recuperable si no hay workers con puntos
        if period.total_points != 0 {
            panic_with_error!(&env, OrgError::Unauthorized);
        }
        if period.fund_amount <= 0 {
            panic_with_error!(&env, OrgError::InvalidAmount);
        }

        let amount = period.fund_amount;

        // [FIX] Actualizar estado ANTES de transferir (CEI pattern)
        period.fund_amount    = 0;
        period.claimed_amount = 0;
        env.storage().persistent().set(&DataKey::Period(period_id), &period);

        let asset = Self::get_reward_asset_internal(&env);
        token::Client::new(&env, &asset)
            .transfer(&env.current_contract_address(), &to, &amount);

        env.events().publish(
            (Symbol::new(&env, "fund_recovered"), period_id),
            (&to, amount),
        );
    }

    /// [NEW] Recupera el dust (tokens no reclamados por división entera o
    /// workers inactivos) después de que haya vencido el plazo de reclamo
    /// (CLAIM_EXPIRY_SECS = 1 año desde la distribución). Solo Owner.
    ///
    /// Calcula el remanente como `fund_amount - claimed_amount` y lo transfiere a `to`.
    /// Deja el contrato con estado consistente (fund_amount = claimed_amount).
    pub fn sweep_expired_claims(env: Env, caller: Address, period_id: u32, to: Address) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_role_owner(&env, &caller);

        let mut period = Self::get_period_or_panic(&env, period_id);

        if period.state != PeriodState::Distributed {
            panic_with_error!(&env, OrgError::InvalidPeriodState);
        }

        // Verificar que el plazo de reclamo haya vencido
        if period.distributed_at == 0
            || env.ledger().timestamp() <= period.distributed_at
                .saturating_add(CLAIM_EXPIRY_SECS)
        {
            panic_with_error!(&env, OrgError::ClaimsNotExpired);
        }

        // checked_sub nunca falla para i128 con valores realistas de tokens,
        // pero usamos unwrap_or_else explícito para que cualquier estado corrupto
        // sea detectable en lugar de silenciarse con 0.
        let dust = period.fund_amount
            .checked_sub(period.claimed_amount)
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::ArithmeticOverflow));

        if dust <= 0 {
            panic_with_error!(&env, OrgError::InvalidAmount);
        }

        // Actualizar estado ANTES de transferir (CEI pattern)
        period.fund_amount = period.claimed_amount; // remanente = 0
        env.storage().persistent().set(&DataKey::Period(period_id), &period);

        let asset = Self::get_reward_asset_internal(&env);
        token::Client::new(&env, &asset)
            .transfer(&env.current_contract_address(), &to, &dust);

        env.events().publish(
            (Symbol::new(&env, "dust_swept"), period_id),
            (&to, dust),
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSULTAS
    // ═══════════════════════════════════════════════════════════════════════════

    pub fn get_worker_stats(env: Env, period_id: u32, worker: Address) -> WorkerStats {
        env.storage()
            .persistent()
            .get(&DataKey::WorkerStats(period_id, worker))
            .unwrap_or_else(WorkerStats::zero)
    }

    pub fn get_reward_asset(env: Env) -> Address {
        Self::get_reward_asset_internal(&env)
    }

    pub fn get_owner(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Owner)
            .unwrap_or_else(|| panic_with_error!(&env, OrgError::NotInitialized))
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS INTERNOS
    // ═══════════════════════════════════════════════════════════════════════════

    fn check_not_paused(env: &Env) {
        if env.storage().instance().get::<DataKey, bool>(&DataKey::Paused).unwrap_or(false) {
            panic_with_error!(env, OrgError::ContractPaused);
        }
    }

    fn get_role_or_panic(env: &Env, addr: &Address) -> Role {
        let info: MemberInfo = env.storage()
            .persistent()
            .get(&DataKey::Member(addr.clone()))
            .unwrap_or_else(|| panic_with_error!(env, OrgError::Unauthorized));
        if !info.active {
            panic_with_error!(env, OrgError::MemberInactive);
        }
        info.role
    }

    fn check_role_owner(env: &Env, addr: &Address) {
        let role = Self::get_role_or_panic(env, addr);
        if role != Role::Owner {
            panic_with_error!(env, OrgError::Unauthorized);
        }
    }

    fn check_role_supervisor_or_owner(env: &Env, addr: &Address) {
        let role = Self::get_role_or_panic(env, addr);
        if role == Role::Worker {
            panic_with_error!(env, OrgError::Unauthorized);
        }
    }

    fn get_period_or_panic(env: &Env, period_id: u32) -> PeriodInfo {
        env.storage()
            .persistent()
            .get(&DataKey::Period(period_id))
            .unwrap_or_else(|| panic_with_error!(env, OrgError::PeriodNotFound))
    }

    fn get_reward_asset_internal(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::RewardAsset)
            .unwrap_or_else(|| panic_with_error!(env, OrgError::NotInitialized))
    }

    fn set_member(env: &Env, addr: &Address, info: &MemberInfo) {
        env.storage().persistent().set(&DataKey::Member(addr.clone()), info);
        env.storage().persistent().extend_ttl(&DataKey::Member(addr.clone()), MAX_TTL, MAX_TTL);
    }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        token::{Client as TokenClient, StellarAssetClient},
        Env,
    };

    // ── Helper de setup ───────────────────────────────────────────────────────

    fn setup() -> (Env, OrgContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        // Inicializar ledger con timestamp > 0 para que los tests de expiración
        // (claim_reward / sweep_expired_claims) funcionen correctamente.
        // Con timestamp = 0, distribute_rewards setearía distributed_at = 0
        // y la guarda `distributed_at > 0` cortocircuitaría los checks de expiración.
        env.ledger().with_mut(|l| { l.timestamp = 1_000; });

        let contract_id = env.register_contract(None, OrgContract);
        let client      = OrgContractClient::new(&env, &contract_id);

        let owner       = Address::generate(&env);
        let usdc_issuer = env.register_stellar_asset_contract(owner.clone());

        client.initialize(&owner, &usdc_issuer);

        (env, client, owner, usdc_issuer)
    }

    /// Crea un ciclo completo: template + período + tarea + aprobación
    /// Devuelve (supervisor, worker, template_id, period_id, task_id)
    fn full_cycle(
        env:    &Env,
        client: &OrgContractClient,
        owner:  &Address,
        asset:  &Address,
        amount: i128,
    ) -> (Address, Address, u32, u32, u32) {
        let supervisor = Address::generate(env);
        let worker     = Address::generate(env);

        client.add_member(owner,      &supervisor, &Role::Supervisor);
        client.add_member(&supervisor, &worker,    &Role::Worker);

        StellarAssetClient::new(env, asset).mint(&supervisor, &amount);

        let template_id = client.create_template(
            &supervisor,
            &String::from_str(env, "Picking"),
            &100u32,
        );
        let period_id = client.open_period(
            &supervisor,
            &env.ledger().timestamp(),
            &(env.ledger().timestamp() + 30 * 24 * 3600),
        );
        let task_id = client.create_task(&supervisor, &worker, &template_id, &period_id);

        client.complete_task(&worker, &task_id, &String::from_str(env, "https://ev.io"));
        client.review_task(&supervisor, &task_id, &true, &10_000u32); // 100%

        (supervisor, worker, template_id, period_id, task_id)
    }

    // ── Tests de inicialización ───────────────────────────────────────────────

    #[test]
    fn test_init_guard() {
        let (env, client, owner, asset) = setup();
        let result = client.try_initialize(&owner, &asset);
        assert!(result.is_err(), "re-inicialización debe fallar");
    }

    // ── Tests de roles y miembros ─────────────────────────────────────────────

    #[test]
    fn test_member_roles() {
        let (env, client, owner, _) = setup();
        let supervisor = Address::generate(&env);
        let worker     = Address::generate(&env);

        client.add_member(&owner, &supervisor, &Role::Supervisor);
        client.add_member(&owner, &worker,     &Role::Worker);

        assert_eq!(client.get_member(&supervisor).role, Role::Supervisor);
        assert_eq!(client.get_member(&worker).role,     Role::Worker);
    }

    #[test]
    fn test_worker_cannot_add_members() {
        let (env, client, owner, _) = setup();
        let worker     = Address::generate(&env);
        let new_member = Address::generate(&env);

        client.add_member(&owner, &worker, &Role::Worker);

        let result = client.try_add_member(&worker, &new_member, &Role::Worker);
        assert!(result.is_err(), "worker no debe poder agregar miembros");
    }

    /// [FIX #16] Supervisor no puede reactivar un Worker que el Owner desactivó
    #[test]
    fn test_supervisor_cannot_reactivate_deactivated_worker() {
        let (env, client, owner, _) = setup();
        let supervisor = Address::generate(&env);
        let worker     = Address::generate(&env);

        client.add_member(&owner,      &supervisor, &Role::Supervisor);
        client.add_member(&supervisor, &worker,     &Role::Worker);

        // Owner desactiva al worker
        client.remove_member(&owner, &worker);
        assert!(!client.get_member(&worker).active);

        // Supervisor intenta reactivarlo → debe fallar
        let result = client.try_add_member(&supervisor, &worker, &Role::Worker);
        assert!(result.is_err(), "Supervisor no debe poder reactivar un Worker desactivado por el Owner");

        // Solo el Owner puede reactivarlo
        client.add_member(&owner, &worker, &Role::Worker);
        assert!(client.get_member(&worker).active);
    }

    /// [FIX #12] Supervisor no puede degradar a otro Supervisor a Worker
    #[test]
    fn test_supervisor_cannot_demote_supervisor() {
        let (env, client, owner, _) = setup();
        let supervisor_a = Address::generate(&env);
        let supervisor_b = Address::generate(&env);

        client.add_member(&owner, &supervisor_a, &Role::Supervisor);
        client.add_member(&owner, &supervisor_b, &Role::Supervisor);

        // supervisor_a intenta degradar supervisor_b → debe fallar
        let result = client.try_add_member(&supervisor_a, &supervisor_b, &Role::Worker);
        assert!(result.is_err(), "Supervisor no debe poder degradar otro Supervisor");

        // Pero Owner sí puede
        client.add_member(&owner, &supervisor_b, &Role::Worker);
        assert_eq!(client.get_member(&supervisor_b).role, Role::Worker);
    }

    #[test]
    fn test_transfer_ownership() {
        let (env, client, owner, _) = setup();
        let new_owner = Address::generate(&env);

        client.transfer_ownership(&owner, &new_owner);

        assert_eq!(client.get_owner(), new_owner);
        // El owner anterior queda como Supervisor
        assert_eq!(client.get_member(&owner).role, Role::Supervisor);
    }

    // ── Tests del ciclo de tareas ─────────────────────────────────────────────

    #[test]
    fn test_full_task_lifecycle() {
        let (env, client, owner, asset) = setup();
        let amount = 100_000_000i128;
        let (supervisor, worker, _, period_id, task_id) =
            full_cycle(&env, &client, &owner, &asset, amount);

        let task = client.get_task(&task_id);
        assert_eq!(task.state,        TaskState::Approved);
        assert_eq!(task.final_points, 100);

        let stats = client.get_worker_stats(&period_id, &worker);
        assert_eq!(stats.total_points,   100);
        assert_eq!(stats.tasks_approved, 1);

        let _ = supervisor; // usado en full_cycle
    }

    #[test]
    fn test_skip_task() {
        let (env, client, owner, _) = setup();
        let supervisor = Address::generate(&env);
        let worker     = Address::generate(&env);

        client.add_member(&owner,      &supervisor, &Role::Supervisor);
        client.add_member(&supervisor, &worker,     &Role::Worker);

        let template_id = client.create_template(
            &supervisor, &String::from_str(&env, "Pack"), &50u32,
        );
        let period_id = client.open_period(
            &supervisor, &0u64, &1_000_000u64,
        );
        let task_id = client.create_task(&supervisor, &worker, &template_id, &period_id);

        client.skip_task(&supervisor, &task_id);

        assert_eq!(client.get_task(&task_id).state, TaskState::Skipped);

        let stats = client.get_worker_stats(&period_id, &worker);
        assert_eq!(stats.tasks_skipped, 1);
        assert_eq!(stats.total_points,  0);
    }

    /// [FIX #1] review_task no puede ejecutarse sobre un período ya Distributed
    #[test]
    fn test_review_task_after_distribution_fails() {
        let (env, client, owner, asset) = setup();
        let amount = 100_000_000i128;

        // Crear un segundo task que quede en Completed sin revisar
        let supervisor = Address::generate(&env);
        let worker_a   = Address::generate(&env);
        let worker_b   = Address::generate(&env);

        client.add_member(&owner,      &supervisor, &Role::Supervisor);
        client.add_member(&supervisor, &worker_a,   &Role::Worker);
        client.add_member(&supervisor, &worker_b,   &Role::Worker);

        StellarAssetClient::new(&env, &asset).mint(&supervisor, &amount);

        let template_id = client.create_template(
            &supervisor, &String::from_str(&env, "Pick"), &100u32,
        );
        let period_id = client.open_period(&supervisor, &0u64, &1_000_000u64);

        let task_a = client.create_task(&supervisor, &worker_a, &template_id, &period_id);
        let task_b = client.create_task(&supervisor, &worker_b, &template_id, &period_id);

        // Completar ambas tareas
        client.complete_task(&worker_a, &task_a, &String::from_str(&env, "ev_a"));
        client.complete_task(&worker_b, &task_b, &String::from_str(&env, "ev_b"));

        // Solo aprobar task_a antes de distribuir
        client.review_task(&supervisor, &task_a, &true, &10_000u32);

        client.close_period(&supervisor, &period_id);
        client.fund_period(&owner, &supervisor, &period_id, &amount);
        client.distribute_rewards(&owner, &period_id);

        // Intentar aprobar task_b DESPUÉS de distribuir → debe fallar
        let result = client.try_review_task(&supervisor, &task_b, &true, &10_000u32);
        assert!(result.is_err(), "review_task sobre período Distributed debe fallar");
    }

    // ── Tests de reclamo de recompensas ───────────────────────────────────────

    #[test]
    fn test_claim_reward_cei_pattern() {
        let (env, client, owner, asset) = setup();
        let amount = 100_000_000i128;
        let (supervisor, worker, _, period_id, _) =
            full_cycle(&env, &client, &owner, &asset, amount);

        client.close_period(&supervisor, &period_id);
        client.fund_period(&owner, &supervisor, &period_id, &amount);
        client.distribute_rewards(&owner, &period_id);

        let usdc   = TokenClient::new(&env, &asset);
        let before = usdc.balance(&worker);
        client.claim_reward(&worker, &period_id);
        let after  = usdc.balance(&worker);

        assert_eq!(after - before, amount, "worker debe recibir todo el fondo");

        // Segundo reclamo debe fallar (CEI / anti double-claim)
        let result = client.try_claim_reward(&worker, &period_id);
        assert!(result.is_err(), "double-claim debe fallar");
    }

    #[test]
    fn test_claim_expired_fails() {
        let (env, client, owner, asset) = setup();
        let amount = 100_000_000i128;
        let (supervisor, worker, _, period_id, _) =
            full_cycle(&env, &client, &owner, &asset, amount);

        client.close_period(&supervisor, &period_id);
        client.fund_period(&owner, &supervisor, &period_id, &amount);
        client.distribute_rewards(&owner, &period_id);

        // Avanzar el tiempo más allá del plazo de reclamo (1 año + 1 segundo)
        env.ledger().with_mut(|l| {
            l.timestamp += CLAIM_EXPIRY_SECS + 1;
        });

        let result = client.try_claim_reward(&worker, &period_id);
        assert!(result.is_err(), "reclamo expirado debe fallar");
    }

    // ── Tests de recover / sweep ──────────────────────────────────────────────

    /// [FIX #3] recover_undistributed debe dejar fund_amount = 0
    #[test]
    fn test_recover_undistributed_zeroes_fund_amount() {
        let (env, client, owner, asset) = setup();
        let supervisor = Address::generate(&env);
        let amount     = 50_000_000i128;

        client.add_member(&owner, &supervisor, &Role::Supervisor);
        StellarAssetClient::new(&env, &asset).mint(&supervisor, &amount);

        // Período sin workers ni puntos
        let period_id = client.open_period(&supervisor, &0u64, &1_000_000u64);
        client.close_period(&supervisor, &period_id);
        client.fund_period(&owner, &supervisor, &period_id, &amount);
        client.distribute_rewards(&owner, &period_id);

        // Recuperar fondo
        client.recover_undistributed(&owner, &period_id, &owner);

        // fund_amount debe ser 0 ahora
        let period = client.get_period(&period_id);
        assert_eq!(period.fund_amount, 0, "fund_amount debe ser 0 tras la recuperación");

        // Intentar recuperar de nuevo → debe fallar (InvalidAmount)
        let result = client.try_recover_undistributed(&owner, &period_id, &owner);
        assert!(result.is_err(), "doble recuperación debe fallar");
    }

    /// [NEW] sweep_expired_claims recupera el dust después del plazo
    #[test]
    fn test_sweep_expired_claims() {
        let (env, client, owner, asset) = setup();
        let amount = 100_000_000i128;

        // Dos workers con puntos distintos → habrá dust por redondeo
        let supervisor = Address::generate(&env);
        let worker_a   = Address::generate(&env);
        let worker_b   = Address::generate(&env);

        client.add_member(&owner,      &supervisor, &Role::Supervisor);
        client.add_member(&supervisor, &worker_a,   &Role::Worker);
        client.add_member(&supervisor, &worker_b,   &Role::Worker);

        StellarAssetClient::new(&env, &asset).mint(&supervisor, &amount);

        let template_id = client.create_template(
            &supervisor, &String::from_str(&env, "Pick"), &10u32,
        );
        let period_id = client.open_period(&supervisor, &0u64, &1_000_000u64);

        // worker_a: 1 tarea (10 pts), worker_b: 2 tareas (20 pts) → total 30
        let task_a1 = client.create_task(&supervisor, &worker_a, &template_id, &period_id);
        let task_b1 = client.create_task(&supervisor, &worker_b, &template_id, &period_id);
        let task_b2 = client.create_task(&supervisor, &worker_b, &template_id, &period_id);

        client.complete_task(&worker_a, &task_a1, &String::from_str(&env, "ev"));
        client.complete_task(&worker_b, &task_b1, &String::from_str(&env, "ev"));
        client.complete_task(&worker_b, &task_b2, &String::from_str(&env, "ev"));

        client.review_task(&supervisor, &task_a1, &true, &10_000u32);
        client.review_task(&supervisor, &task_b1, &true, &10_000u32);
        client.review_task(&supervisor, &task_b2, &true, &10_000u32);

        client.close_period(&supervisor, &period_id);
        client.fund_period(&owner, &supervisor, &period_id, &amount);
        client.distribute_rewards(&owner, &period_id);

        // Solo worker_a reclama, worker_b no reclama
        client.claim_reward(&worker_a, &period_id);

        // Avanzar tiempo más allá del plazo
        env.ledger().with_mut(|l| {
            l.timestamp += CLAIM_EXPIRY_SECS + 1;
        });

        // Sweep debe fallar si aún no venció — ya vencimos el tiempo,
        // pero verificamos también el caso antes del vencimiento con
        // un período diferente para asegurar la guarda
        let usdc          = TokenClient::new(&env, &asset);
        let owner_before  = usdc.balance(&owner);
        client.sweep_expired_claims(&owner, &period_id, &owner);
        let owner_after   = usdc.balance(&owner);

        // El owner recibió los fondos de worker_b no reclamados
        assert!(owner_after > owner_before, "Owner debe recibir el dust de claims expirados");

        // Doble sweep debe fallar
        let result = client.try_sweep_expired_claims(&owner, &period_id, &owner);
        assert!(result.is_err(), "doble sweep debe fallar");
    }

    #[test]
    fn test_sweep_before_expiry_fails() {
        let (env, client, owner, asset) = setup();
        let amount = 100_000_000i128;
        let (supervisor, _, _, period_id, _) =
            full_cycle(&env, &client, &owner, &asset, amount);

        client.close_period(&supervisor, &period_id);
        client.fund_period(&owner, &supervisor, &period_id, &amount);
        client.distribute_rewards(&owner, &period_id);

        // Sin avanzar el tiempo → debe fallar
        let result = client.try_sweep_expired_claims(&owner, &period_id, &owner);
        assert!(result.is_err(), "sweep antes del vencimiento debe fallar");
    }

    // ── Tests de pause ────────────────────────────────────────────────────────

    #[test]
    fn test_pause_blocks_operations() {
        let (env, client, owner, _) = setup();
        let supervisor = Address::generate(&env);

        client.pause(&owner);

        let result = client.try_add_member(&owner, &supervisor, &Role::Supervisor);
        assert!(result.is_err(), "operaciones bloqueadas mientras está pausado");
    }

    #[test]
    fn test_unpause_restores_operations() {
        let (env, client, owner, _) = setup();
        let supervisor = Address::generate(&env);

        client.pause(&owner);
        client.unpause(&owner);

        // Después del unpause debe funcionar normalmente
        client.add_member(&owner, &supervisor, &Role::Supervisor);
        assert_eq!(client.get_member(&supervisor).role, Role::Supervisor);
    }

    // ── Self-review findings (docs/audit/findings.md) ─────────────────────────
    // These tests pin the CURRENT behaviour of each finding, so that a fix
    // shows up as a deliberate change to the matching test.

    /// HMY-01: the Owner can demote itself through `add_member` and loses every
    /// Owner-only entry point for good (pause, distribute_rewards,
    /// transfer_ownership…), while `DataKey::Owner` still points to it.
    #[test]
    fn finding_hmy01_owner_can_demote_itself() {
        let (env, client, owner, _) = setup();
        let other = Address::generate(&env);

        client.add_member(&owner, &owner, &Role::Supervisor);

        assert_eq!(client.get_member(&owner).role, Role::Supervisor);
        assert_eq!(client.get_owner(), owner);
        assert!(client.try_pause(&owner).is_err());
        assert!(client.try_transfer_ownership(&owner, &other).is_err());
    }

    /// HMY-02: `final_points` is computed in u64 and narrowed with `as u32`,
    /// which truncates silently above u32::MAX.
    #[test]
    fn finding_hmy02_final_points_truncate_above_u32_max() {
        let (env, client, owner, _) = setup();
        let worker = Address::generate(&env);
        client.add_member(&owner, &worker, &Role::Worker);

        let template_id = client.create_template(&owner, &String::from_str(&env, "Big"), &3_000_000_000u32);
        let period_id   = client.open_period(&owner, &0u64, &1_000_000u64);
        let task_id     = client.create_task(&owner, &worker, &template_id, &period_id);
        client.complete_task(&worker, &task_id, &String::from_str(&env, "ev"));
        client.review_task(&owner, &task_id, &true, &20_000u32); // 200% → 6_000_000_000

        let truncated = (6_000_000_000u64 - (u32::MAX as u64 + 1)) as u32;
        assert_eq!(client.get_task(&task_id).final_points, truncated);
        assert_eq!(client.get_period(&period_id).total_points, truncated as u64);
    }

    /// HMY-03: a member deactivated by the Owner can still complete a task that
    /// was assigned before the deactivation (`complete_task` does not check `active`).
    #[test]
    fn finding_hmy03_inactive_worker_can_complete_assigned_task() {
        let (env, client, owner, _) = setup();
        let worker = Address::generate(&env);
        client.add_member(&owner, &worker, &Role::Worker);

        let template_id = client.create_template(&owner, &String::from_str(&env, "Pick"), &10u32);
        let period_id   = client.open_period(&owner, &0u64, &1_000_000u64);
        let task_id     = client.create_task(&owner, &worker, &template_id, &period_id);

        client.remove_member(&owner, &worker);
        client.complete_task(&worker, &task_id, &String::from_str(&env, "ev"));

        assert_eq!(client.get_task(&task_id).state, TaskState::Completed);
    }

    /// HMY-04: deactivating a worker after distribution blocks its claim; its
    /// share stays in the contract until the Owner sweeps it after the expiry.
    #[test]
    fn finding_hmy04_deactivated_worker_cannot_claim() {
        let (env, client, owner, asset) = setup();
        let amount = 1_000i128;
        let (supervisor, worker, _, period_id, _) =
            full_cycle(&env, &client, &owner, &asset, amount);

        client.close_period(&supervisor, &period_id);
        client.fund_period(&owner, &supervisor, &period_id, &amount);
        client.distribute_rewards(&owner, &period_id);
        client.remove_member(&owner, &worker);

        assert!(client.try_claim_reward(&worker, &period_id).is_err());
    }

    /// HMY-05: `pause` also blocks `claim_reward` on a period that was already
    /// distributed: the Owner can freeze payouts.
    #[test]
    fn finding_hmy05_pause_blocks_claims() {
        let (env, client, owner, asset) = setup();
        let amount = 1_000i128;
        let (supervisor, worker, _, period_id, _) =
            full_cycle(&env, &client, &owner, &asset, amount);

        client.close_period(&supervisor, &period_id);
        client.fund_period(&owner, &supervisor, &period_id, &amount);
        client.distribute_rewards(&owner, &period_id);
        client.pause(&owner);

        assert!(client.try_claim_reward(&worker, &period_id).is_err());
        client.unpause(&owner);
        client.claim_reward(&worker, &period_id);
    }

    /// HMY-06: a task left in Completed when the period is distributed can never
    /// be reviewed, so its points are lost (see also
    /// test_review_task_after_distribution_fails).
    #[test]
    fn finding_hmy06_unreviewed_task_is_lost_after_distribution() {
        let (env, client, owner, asset) = setup();
        let amount = 1_000i128;
        let worker = Address::generate(&env);
        client.add_member(&owner, &worker, &Role::Worker);
        StellarAssetClient::new(&env, &asset).mint(&owner, &amount);

        let template_id = client.create_template(&owner, &String::from_str(&env, "Pick"), &10u32);
        let period_id   = client.open_period(&owner, &0u64, &1_000_000u64);
        let task_id     = client.create_task(&owner, &worker, &template_id, &period_id);
        client.complete_task(&worker, &task_id, &String::from_str(&env, "ev"));

        client.close_period(&owner, &period_id);
        let funder = Address::generate(&env);
        StellarAssetClient::new(&env, &asset).mint(&funder, &amount);
        client.fund_period(&owner, &funder, &period_id, &amount);
        client.distribute_rewards(&owner, &period_id);

        assert!(client.try_review_task(&owner, &task_id, &true, &10_000u32).is_err());
        assert_eq!(client.get_period(&period_id).total_points, 0);
    }

    /// HMY-07: `start_time`/`end_time` are informational: tasks can be created
    /// after `end_time` while the period is Open.
    #[test]
    fn finding_hmy07_period_time_bounds_not_enforced() {
        let (env, client, owner, _) = setup(); // ledger timestamp = 1_000
        let worker = Address::generate(&env);
        client.add_member(&owner, &worker, &Role::Worker);

        let template_id = client.create_template(&owner, &String::from_str(&env, "Pick"), &10u32);
        let period_id   = client.open_period(&owner, &1u64, &10u64); // ended long ago
        let task_id     = client.create_task(&owner, &worker, &template_id, &period_id);

        assert_eq!(client.get_task(&task_id).state, TaskState::Assigned);
    }

    /// HMY-08: `fund_period` calls `require_auth` on `caller` and on `funder`.
    /// When both are the same address the second call hits Auth/ExistingValue
    /// unless the address authorizes as the transaction source account (verified
    /// on testnet, see docs/audit/findings.md).
    #[test]
    fn finding_hmy08_same_caller_and_funder_double_auth() {
        let (env, client, owner, asset) = setup();
        StellarAssetClient::new(&env, &asset).mint(&owner, &100i128);
        let period_id = client.open_period(&owner, &0u64, &1_000_000u64);

        assert!(client.try_fund_period(&owner, &owner, &period_id, &100i128).is_err());
    }

    /// HMY-16: `initialize` only requires the auth of the `owner` argument, so
    /// whoever calls it first after the deploy becomes the Owner.
    #[test]
    fn finding_hmy16_initialize_can_be_front_run() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, OrgContract);
        let client      = OrgContractClient::new(&env, &contract_id);

        let intended = Address::generate(&env);
        let attacker = Address::generate(&env);
        let asset    = env.register_stellar_asset_contract(attacker.clone());

        client.initialize(&attacker, &asset);

        assert!(client.try_initialize(&intended, &asset).is_err());
        assert_eq!(client.get_owner(), attacker);
    }

    /// HMY-17: a Supervisor can assign a task to itself, complete it and approve
    /// it at 200%, minting points (and a fund share) for itself.
    #[test]
    fn finding_hmy17_supervisor_can_review_its_own_task() {
        let (env, client, owner, _) = setup();
        let supervisor = Address::generate(&env);
        client.add_member(&owner, &supervisor, &Role::Supervisor);

        let template_id = client.create_template(&supervisor, &String::from_str(&env, "Pick"), &100u32);
        let period_id   = client.open_period(&supervisor, &0u64, &1_000_000u64);
        let task_id     = client.create_task(&supervisor, &supervisor, &template_id, &period_id);
        client.complete_task(&supervisor, &task_id, &String::from_str(&env, "ev"));
        client.review_task(&supervisor, &task_id, &true, &20_000u32);

        assert_eq!(client.get_worker_stats(&period_id, &supervisor).total_points, 200);
    }
}
