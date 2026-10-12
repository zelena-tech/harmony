//! # Harmony Factory Contract
//!
//! Punto de entrada único para el ecosistema Harmony.
//! Registra y lleva el directorio de contratos de organización.
//!
//! ## Seguridad
//! - Solo el admin puede registrar nuevas organizaciones
//! - Inicialización única (guard contra re-inicialización)
//! - Transfer de admin requiere firma de AMBAS partes (viejo y nuevo)
//! - Todos los cambios emiten eventos on-chain para auditoría

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, panic_with_error,
    Address, Env, Symbol,
};

// ─── TTL (tiempo de vida en ledger) ──────────────────────────────────────────
// ~5 segundos por ledger en Stellar
const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_TTL:   u32 = 30  * DAY_IN_LEDGERS; //  30 días
const MAX_TTL:        u32 = 365 * DAY_IN_LEDGERS; // 365 días

// ─── Errores ─────────────────────────────────────────────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum FactoryError {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    Unauthorized       = 3,
    OrgNotFound        = 4,
    Overflow           = 5,
}

// ─── Claves de storage ───────────────────────────────────────────────────────
#[contracttype]
pub enum DataKey {
    Admin,
    OrgCount,
    Org(u64), // org_id → contract_address
}

// ─── Contrato ─────────────────────────────────────────────────────────────────
#[contract]
pub struct FactoryContract;

#[contractimpl]
impl FactoryContract {

    // ── Inicialización ────────────────────────────────────────────────────────

    /// Inicializa el factory. Solo puede llamarse UNA vez.
    /// El admin debe firmar la transacción.
    pub fn initialize(env: Env, admin: Address) {
        // Guard: si ya existe un admin, rechazar
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, FactoryError::AlreadyInitialized);
        }

        admin.require_auth(); // firma criptográfica obligatoria

        env.storage().instance().set(&DataKey::Admin,    &admin);
        env.storage().instance().set(&DataKey::OrgCount, &0u64);
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);

        env.events().publish(
            (Symbol::new(&env, "factory_init"),),
            admin,
        );
    }

    // ── Gestión de organizaciones ─────────────────────────────────────────────

    /// Registra la dirección de un contrato de organización desplegado.
    /// Solo el admin puede llamar esto. Devuelve el org_id asignado.
    pub fn register_org(env: Env, org_address: Address) -> u64 {
        Self::require_admin(&env);

        let count: u64 = env.storage().instance()
            .get(&DataKey::OrgCount)
            .unwrap_or(0);

        let new_id = count
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, FactoryError::Overflow));

        // Persistent: datos de larga duración por organización
        env.storage().persistent().set(&DataKey::Org(new_id), &org_address);
        env.storage().persistent().extend_ttl(&DataKey::Org(new_id), MAX_TTL, MAX_TTL);

        env.storage().instance().set(&DataKey::OrgCount, &new_id);
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);

        env.events().publish(
            (Symbol::new(&env, "org_registered"), new_id),
            org_address,
        );

        new_id
    }

    /// Obtiene la dirección del contrato de organización por ID.
    pub fn get_org(env: Env, org_id: u64) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Org(org_id))
            .unwrap_or_else(|| panic_with_error!(&env, FactoryError::OrgNotFound))
    }

    /// Cantidad total de organizaciones registradas.
    pub fn get_org_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::OrgCount).unwrap_or(0)
    }

    // ── Gestión de admin ──────────────────────────────────────────────────────

    /// Obtiene el admin actual.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, FactoryError::NotInitialized))
    }

    /// Transfiere el rol de admin.
    /// SEGURIDAD: requiere firma de AMBOS — admin actual Y nuevo admin.
    /// Esto previene que el admin actual transfiera a una dirección sin control.
    pub fn transfer_admin(env: Env, new_admin: Address) {
        Self::require_admin(&env);
        new_admin.require_auth(); // el nuevo admin también debe firmar

        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);

        env.events().publish(
            (Symbol::new(&env, "admin_transferred"),),
            new_admin,
        );
    }

    // ── Helpers internos ──────────────────────────────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, FactoryError::NotInitialized));
        admin.require_auth();
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    #[test]
    fn test_initialize_and_register() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, FactoryContract);
        let client = FactoryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_org_count(), 0);

        let org = Address::generate(&env);
        let org_id = client.register_org(&org);

        assert_eq!(org_id, 1);
        assert_eq!(client.get_org(&org_id), org);
        assert_eq!(client.get_org_count(), 1);
    }

    #[test]
    #[should_panic]
    fn test_double_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, FactoryContract);
        let client = FactoryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);
        client.initialize(&admin); // debe fallar
    }

    #[test]
    fn test_transfer_admin() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, FactoryContract);
        let client = FactoryContractClient::new(&env, &contract_id);

        let admin     = Address::generate(&env);
        let new_admin = Address::generate(&env);

        client.initialize(&admin);
        client.transfer_admin(&new_admin);

        assert_eq!(client.get_admin(), new_admin);
    }

    /// HMY-09 (docs/audit/findings.md): the factory is a registry, not a
    /// deployer. `register_org` accepts any address, including one that is
    /// already registered, and never checks that it runs the organization wasm.
    #[test]
    fn finding_hmy09_register_org_accepts_duplicates() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, FactoryContract);
        let client = FactoryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let org = Address::generate(&env);
        assert_eq!(client.register_org(&org), 1);
        assert_eq!(client.register_org(&org), 2);
        assert_eq!(client.get_org(&1), client.get_org(&2));
    }

    /// HMY-16: whoever calls `initialize` first after the deploy becomes admin.
    #[test]
    fn finding_hmy16_initialize_can_be_front_run() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, FactoryContract);
        let client = FactoryContractClient::new(&env, &contract_id);

        let intended = Address::generate(&env);
        let attacker = Address::generate(&env);
        client.initialize(&attacker);

        assert!(client.try_initialize(&intended).is_err());
        assert_eq!(client.get_admin(), attacker);
    }
}
