/**
 * desplegar-y-pagar-mainnet.mjs — Pago privado de Harmony con el token confidencial AUDITADO de
 * OpenZeppelin (stellar-contracts v0.8.0), listo para MAINNET. Lo corre el FOUNDER, no un agente.
 *
 * QUE HACE (ACCION=pagar, por defecto)
 *   0. Preflight: verifica la integridad de oz-v0.8.0/ (sha256 del manifiesto), imprime red, cuenta,
 *      saldos XLM/USDC, contratos (nuevos o reutilizados) y montos. En mainnet se DETIENE aqui
 *      salvo que CONFIRMO_MAINNET=si.
 *   1. Subyacente: testnet -> USDC de PRUEBA emitido por un emisor propio (+ su SAC);
 *      mainnet -> USDC de Circle (emisor GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN) via su SAC.
 *   2. Despliega la pila completa desde los wasm de oz-v0.8.0/wasm (o reutiliza los ids guardados en
 *      <red>-contratos.json): verificador UltraHonk con las 6 VKs fijadas de v0.8.0, registro de
 *      auditor con la llave de auditor de Zelena, y token confidencial (compliant-token) que envuelve
 *      el SAC. Configuracion de cumplimiento: sin politica, sin passthrough SAC.
 *   3. Crea/fondea las cuentas de los 3 operarios (testnet: friendbot; mainnet: createAccount desde la
 *      cuenta del founder con OPERARIO_XLM de saldo inicial) y los registra en el token.
 *   4. Deposita el total de MONTOS (deposito publico = el "lote"), lo pasa a saldo gastable (merge) y
 *      hace 3 transferencias confidenciales (los montos no aparecen en claro en cadena).
 *   5. Verifica: cada operario descifra SOLO lo suyo, otro operario NO puede abrirlo, el auditor de
 *      Zelena ve los 3 montos. Imprime enlaces a stellar.expert y el costo real en XLM.
 *
 * RECUPERAR FONDOS (ACCION=retirar)
 *   QUIEN=empleador (por defecto) | operario1 | operario2 | operario3 [MONTO=usdc, por defecto todo]
 *   Pasa lo recibido a gastable (merge) y desenvuelve con prueba withdraw: el USDC vuelve como USDC
 *   publico a la cuenta del titular (DESTINO=G... para otra cuenta con trustline USDC). Para un
 *   operario generado por este script se crea antes su trustline USDC (0.5 XLM de reserva).
 *
 * SOLO LECTURA (ACCION=estado): imprime el preflight y termina.
 *
 * VARIABLES
 *   RED=testnet|mainnet           (por defecto testnet)
 *   MONTOS="4,3,3"                USDC enteros, uno por operario (por defecto 4,3,3)
 *   FIRMANTE_SECRETO=S...         cuenta del founder (OBLIGATORIA en mainnet; en testnet opcional).
 *                                 Se lee SOLO del entorno: nunca se escribe a disco ni a logs.
 *   CONFIRMO_MAINNET=si           sin esto, en mainnet solo se imprime el preflight.
 *   OPERARIOS_SECRETOS=S..,S..,S.. opcional: cuentas propias de los operarios (no se guardan). Si no
 *                                 se dan, se generan y se guardan en .<red>-llaves.json (gitignored).
 *   OPERARIO_XLM=2                XLM iniciales de cada operario generado en mainnet (reserva + fees).
 *   RPC_URL=...                   RPC de Soroban (mainnet por defecto: https://mainnet.sorobanrpc.com).
 *   NUEVO=1                       ignora <red>-contratos.json y despliega una pila nueva.
 *
 * ARCHIVOS
 *   .<red>-llaves.json      SECRETO, gitignored: llave del auditor de Zelena, operarios generados y
 *                           (solo testnet) cuentas de prueba. En mainnet guardelo en un lugar seguro:
 *                           sin la llave del auditor no se pueden auditar los pagos y sin las de los
 *                           operarios no se puede retirar su saldo.
 *   <red>-contratos.json    publico: ids de contratos, hashes de wasm y ledger inicial.
 *
 * COMO SE CORRE (desde herramientas/pago-privado, tras npm install)
 *   Ensayo en testnet:   MONTOS="4,3,3" node desplegar-y-pagar-mainnet.mjs
 *   Preflight mainnet:   RED=mainnet MONTOS="4,3,3" FIRMANTE_SECRETO=S... node desplegar-y-pagar-mainnet.mjs
 *   Pago real mainnet:   RED=mainnet MONTOS="4,3,3" FIRMANTE_SECRETO=S... CONFIRMO_MAINNET=si node desplegar-y-pagar-mainnet.mjs
 *
 * ADVERTENCIA
 *   El verificador actual de OpenZeppelin v0.8.0 acepta pruebas UltraHonk NO zero-knowledge
 *   (sin --zk): los montos no estan garantizados criptograficamente privados todavia. La cuenta que
 *   despliega queda como admin/manager del verificador (puede cambiar VKs = puede falsificar pruebas):
 *   en produccion ese rol va detras de multisig + timelock.
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIR_OZ, CIRCUITOS_VK, probarRegistro, probarTransferencia, probarRetiro } from "./prover-oz-v080.mjs";

const require = createRequire(import.meta.url);
const ct = require("stellar-confidential-token-sdk");
const ctChain = require("stellar-confidential-token-sdk/chain");
const S = createRequire(require.resolve("stellar-confidential-token-sdk"))("@stellar/stellar-sdk");
const { Keypair, Networks, Address, Asset, Operation, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative, xdr, rpc } = S;

// ---------------------------------------------------------------- configuracion

const AQUI = dirname(fileURLToPath(import.meta.url));
const RED = (process.env.RED || "testnet").toLowerCase();
if (!["testnet", "mainnet"].includes(RED)) throw new Error(`RED debe ser testnet o mainnet, no "${RED}"`);
const MAINNET = RED === "mainnet";
const CFG = MAINNET
  ? { rpc: process.env.RPC_URL || "https://mainnet.sorobanrpc.com", pass: Networks.PUBLIC, exp: "https://stellar.expert/explorer/public" }
  : { rpc: process.env.RPC_URL || "https://soroban-testnet.stellar.org", pass: Networks.TESTNET, exp: "https://stellar.expert/explorer/testnet" };
const USDC_CIRCLE = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ACCION = (process.env.ACCION || "pagar").toLowerCase();
const ARCHIVO_LLAVES = join(AQUI, `.${RED}-llaves.json`);
const ARCHIVO_CONTRATOS = join(AQUI, `${RED}-contratos.json`);
const AUDITOR_ID = 0;
const D = 10_000_000n; // 7 decimales de los activos clasicos
const MONTOS = (process.env.MONTOS || "4,3,3").split(",").map((m) => BigInt(m.trim()));
if (MONTOS.length !== 3 || MONTOS.some((m) => m <= 0n)) throw new Error('MONTOS debe tener 3 enteros positivos, p. ej. "4,3,3"');
const TOTAL = MONTOS.reduce((a, b) => a + b, 0n);
const OPERARIO_XLM = process.env.OPERARIO_XLM || "2";
const WASM = {
  verificador: "confidential_verifier_example.wasm",
  auditor: "confidential_auditor_example.wasm",
  token: "confidential_compliant_token_example.wasm",
};

const server = new rpc.Server(CFG.rpc);
const log = (paso, msg) => console.log(`\n[${paso}] ${msg}`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const xlm = (stroops) => (Number(stroops) / 1e7).toFixed(4);
const usdc = (u) => (Number(u) / 1e7).toFixed(2);
const enlaceTx = (h) => `${CFG.exp}/tx/${h}`;
const enlaceContrato = (id) => `${CFG.exp}/contract/${id}`;
const gasto = { fees: 0n, reservas: 0n, txs: 0 };

// ---------------------------------------------------------------- llaves y estado (sin secretos en logs)

function leerJson(ruta, porDefecto) {
  return existsSync(ruta) ? JSON.parse(readFileSync(ruta, "utf8")) : porDefecto;
}
const llaves = leerJson(ARCHIVO_LLAVES, { nota: `SECRETO (${RED}). Gitignored. No commitear ni compartir.` });
const guardarLlaves = () => writeFileSync(ARCHIVO_LLAVES, JSON.stringify(llaves, null, 2));
let contratos = process.env.NUEVO ? {} : leerJson(ARCHIVO_CONTRATOS, {});
const guardarContratos = () => writeFileSync(ARCHIVO_CONTRATOS, JSON.stringify({ red: RED, ...contratos }, null, 2) + "\n");

function nuevoAuditorSk() {
  const n = ct.FR_MODULUS < ct.FP_MODULUS ? ct.FR_MODULUS : ct.FP_MODULUS;
  const azar = BigInt("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("hex"));
  return ((azar % (n - 1n)) + 1n).toString();
}

function cuentas() {
  let firmante;
  if (process.env.FIRMANTE_SECRETO) firmante = Keypair.fromSecret(process.env.FIRMANTE_SECRETO.trim());
  else if (MAINNET) throw new Error("En mainnet FIRMANTE_SECRETO es obligatorio (se lee solo del entorno).");
  else {
    llaves.empleador_testnet ??= Keypair.random().secret();
    firmante = Keypair.fromSecret(llaves.empleador_testnet);
  }
  let operarios;
  if (process.env.OPERARIOS_SECRETOS) {
    const sec = process.env.OPERARIOS_SECRETOS.split(",").map((s) => s.trim());
    if (sec.length !== 3) throw new Error("OPERARIOS_SECRETOS debe traer 3 secretos separados por coma");
    operarios = sec.map((s, i) => ({ alias: `Operario ${String(i + 1).padStart(2, "0")}`, kp: Keypair.fromSecret(s), generado: false }));
  } else {
    llaves.operarios ??= [1, 2, 3].map((i) => ({ alias: `Operario ${String(i).padStart(2, "0")}`, secreto: Keypair.random().secret() }));
    operarios = llaves.operarios.map((o) => ({ alias: o.alias, kp: Keypair.fromSecret(o.secreto), generado: true }));
  }
  if (!MAINNET) llaves.emisor_usdc_testnet ??= Keypair.random().secret();
  llaves.auditor_sk ??= nuevoAuditorSk();
  guardarLlaves();
  return { firmante, operarios, auditorSk: BigInt(llaves.auditor_sk) };
}

function integridad() {
  const man = JSON.parse(readFileSync(join(DIR_OZ, "manifiesto.json"), "utf8"));
  for (const [ruta, esperado] of Object.entries(man.sha256)) {
    const real = createHash("sha256").update(readFileSync(join(DIR_OZ, ruta))).digest("hex");
    if (real !== esperado) throw new Error(`integridad: ${ruta} no coincide con el manifiesto (sha256 ${real})`);
  }
  return man;
}

// ---------------------------------------------------------------- red

async function existeCuenta(pub) {
  try {
    await server.getAccount(pub);
    return true;
  } catch {
    return false;
  }
}

async function esperar(hash) {
  for (let i = 0; i < 90; i++) {
    const r = await server.getTransaction(hash);
    if (r.status === "SUCCESS") return r;
    if (r.status === "FAILED") throw new Error(`tx ${hash} FALLO (${enlaceTx(hash)})`);
    await dormir(1000);
  }
  throw new Error(`tx ${hash} sin confirmar`);
}

/** Construye, simula (Soroban), firma y envia. La fuente paga el fee; el fee real se acumula en `gasto`. */
async function enviar(fuente, ops, { soroban = false, firmantes = [] } = {}) {
  const cuenta = await server.getAccount(fuente.publicKey());
  let tx = new TransactionBuilder(cuenta, { fee: (BigInt(BASE_FEE) * 100n).toString(), networkPassphrase: CFG.pass });
  for (const op of ops) tx = tx.addOperation(op);
  tx = tx.setTimeout(180).build();
  if (soroban) tx = await server.prepareTransaction(tx);
  tx.sign(fuente, ...firmantes);
  const env = await server.sendTransaction(tx);
  if (env.status === "ERROR") throw new Error(`envio rechazado: ${env.errorResult?.result?.()?.switch?.()?.name ?? JSON.stringify(env)}`);
  const r = await esperar(env.hash);
  const fee = BigInt(r.resultXdr.feeCharged().toString());
  gasto.fees += fee;
  gasto.txs += 1;
  return { hash: env.hash, retorno: r.returnValue, ledger: r.ledger, fee };
}

const invocar = (fuente, contrato, fn, args) =>
  enviar(fuente, [Operation.invokeContractFunction({ contract: contrato, function: fn, args })], { soroban: true });

/** Llamada de solo lectura (simulacion): no firma ni envia nada. */
async function leer(fuentePub, contrato, fn, args) {
  const cuenta = await server.getAccount(fuentePub);
  const tx = new TransactionBuilder(cuenta, { fee: BASE_FEE, networkPassphrase: CFG.pass })
    .addOperation(Operation.invokeContractFunction({ contract: contrato, function: fn, args }))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return sim.result?.retval;
}

async function saldoSac(fuentePub, sac, quien) {
  try {
    return BigInt(scValToNative(await leer(fuentePub, sac, "balance", [addr(quien)])));
  } catch {
    return null; // sin trustline o sin cuenta
  }
}

async function wasmInstalado(hash) {
  const llave = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash }));
  const { entries } = await server.getLedgerEntries(llave);
  return entries.length > 0;
}

async function existeContrato(id) {
  if (!id) return false;
  try {
    const llave = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(id).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    return (await server.getLedgerEntries(llave)).entries.length > 0;
  } catch {
    return false;
  }
}

const addr = (a) => new Address(a).toScVal();
const u32 = (n) => xdr.ScVal.scvU32(n);
const i128 = (v) => nativeToScVal(v, { type: "i128" });
const bytes = (b) => xdr.ScVal.scvBytes(Buffer.from(b));

async function subirWasm(fuente, archivo) {
  const codigo = readFileSync(join(DIR_OZ, "wasm", archivo));
  const hash = createHash("sha256").update(codigo).digest();
  if (!(await wasmInstalado(hash))) await enviar(fuente, [Operation.uploadContractWasm({ wasm: codigo })], { soroban: true });
  return hash;
}

async function desplegar(fuente, wasmHash, args) {
  const op = Operation.createCustomContract({
    address: new Address(fuente.publicKey()),
    wasmHash,
    constructorArgs: args,
    salt: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
  });
  const r = await enviar(fuente, [op], { soroban: true });
  return { id: Address.fromScVal(r.retorno).toString(), hash: r.hash, ledger: r.ledger };
}

// ---------------------------------------------------------------- token confidencial

/** Identidad confidencial derivada de la firma de la cuenta (no se guarda nada). */
function identidad(kp, token) {
  const raiz = new Uint8Array(kp.signMessage(Buffer.from(ct.skSigningMessage(token, kp.publicKey()))));
  const { sk, addrF } = ct.deriveSk(raiz, token, kp.publicKey());
  return { keys: ct.deriveKeys(sk, addrF, ct.addressToField(kp.publicKey())), address: kp.publicKey(), kp };
}

function eventosDe(dir, eventos) {
  return eventos.filter((ev) =>
    ev.type === "register" || ev.type === "merge" ? ev.account === dir : ["deposit", "withdraw", "transfer"].includes(ev.type) && (ev.from === dir || ev.to === dir),
  );
}

async function eventos(cliente, desde) {
  return (await ctChain.hybridFetchEvents(cliente, undefined, { fromLedger: desde })).events;
}

const iguales = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** Apertura (v, r) del saldo gastable: la local si cuadra con la cadena; si no, se reconstruye de eventos. */
async function aperturaGastable(cliente, id) {
  const enCadena = await cliente.confidentialBalance(id.address);
  const cGasto = ct.pointToBytes(enCadena.spendableBalance);
  const local = llaves.aperturas?.[id.address];
  if (local && iguales(ct.pointToBytes(ct.commit(BigInt(local.v), BigInt(local.r))), cGasto)) return { v: BigInt(local.v), r: BigInt(local.r), recibiendo: enCadena };
  const motor = new ct.StateEngine({ address: id.address, keys: id.keys });
  motor.ingestEvents(eventosDe(id.address, await eventos(cliente, contratos.desde_ledger)));
  const chk = motor.verifyAgainstChain({ spendableC: cGasto, receivingC: ct.pointToBytes(enCadena.receivingBalance) });
  if (!chk.ok) throw new Error(`no pude reconstruir el saldo de ${id.address} (historial fuera de la retencion del RPC?)`);
  const st = motor.state();
  return { v: st.spendable.v, r: st.spendable.r, recibiendo: enCadena, motor };
}

function recordarApertura(dir, next) {
  llaves.aperturas ??= {};
  llaves.aperturas[dir] = { v: next.v.toString(), r: next.r.toString() };
  guardarLlaves();
}

// ---------------------------------------------------------------- flujo

async function main() {
  const man = integridad();
  const { firmante, operarios, auditorSk } = cuentas();
  const yo = firmante.publicKey();
  const emisor = MAINNET ? null : Keypair.fromSecret(llaves.emisor_usdc_testnet);
  const activo = new Asset("USDC", MAINNET ? USDC_CIRCLE : emisor.publicKey());
  const sac = activo.contractId(CFG.pass);
  const sacXlm = Asset.native().contractId(CFG.pass);

  if (!MAINNET) {
    log("0", "Testnet: fondeando cuentas con friendbot…");
    for (const k of [firmante, emisor, ...operarios.map((o) => o.kp)]) {
      if (!(await existeCuenta(k.publicKey()))) {
        const r = await fetch(`https://friendbot.stellar.org?addr=${k.publicKey()}`);
        if (!r.ok && r.status !== 400) throw new Error(`friendbot fallo (${r.status})`);
      }
    }
  }
  if (!(await existeCuenta(yo))) throw new Error(`la cuenta firmante ${yo} no existe en ${RED}`);

  // ------------------------------------------------ preflight
  const reutiliza = (await existeContrato(contratos.token)) && (await existeContrato(contratos.verificador)) && (await existeContrato(contratos.auditor));
  const saldoXlm = await saldoSac(yo, sacXlm, yo);
  const saldoUsdc = await saldoSac(yo, sac, yo);
  console.log("\n================ PREFLIGHT ================");
  console.log(`  red            ${RED}  (${CFG.rpc})`);
  console.log(`  accion         ${ACCION}`);
  console.log(`  firmante       ${yo}`);
  console.log(`  saldo XLM      ${saldoXlm === null ? "?" : xlm(saldoXlm)}`);
  console.log(`  saldo USDC     ${saldoUsdc === null ? "sin trustline" : usdc(saldoUsdc)}  (${MAINNET ? "USDC de Circle" : "USDC de PRUEBA"} ${activo.getIssuer()})`);
  console.log(`  SAC USDC       ${sac}`);
  console.log(`  contratos      ${reutiliza ? `REUTILIZA ${ARCHIVO_CONTRATOS}` : "despliegue NUEVO (verificador + 6 VKs + auditor + token)"}`);
  if (reutiliza) for (const k of ["verificador", "auditor", "token"]) console.log(`    ${k.padEnd(12)} ${contratos[k]}`);
  console.log(`  codigo         OpenZeppelin stellar-contracts ${man.oz_tag} (${man.oz_commit}), integridad sha256 OK`);
  if (ACCION === "pagar") {
    console.log(`  montos         ${MONTOS.join(" / ")} USDC  (total ${TOTAL} USDC)`);
    operarios.forEach((o) => console.log(`    ${o.alias}  ${o.kp.publicKey()}${o.generado ? "  (generado, llave en " + ARCHIVO_LLAVES.split(/[\\/]/).pop() + ")" : ""}`));
    if (MAINNET) console.log(`  reservas       ${OPERARIO_XLM} XLM por operario sin cuenta (createAccount)`);
  }
  console.log("==========================================\n");

  if (ACCION === "estado") return;
  if (MAINNET && process.env.CONFIRMO_MAINNET !== "si") {
    console.log("MAINNET: no se envio nada. Revise el resumen y repita con CONFIRMO_MAINNET=si para ejecutar.");
    return;
  }
  if (ACCION === "pagar" && MAINNET && (saldoUsdc ?? 0n) < TOTAL * D) throw new Error(`saldo USDC insuficiente: hace falta ${TOTAL} USDC en ${yo}`);
  if (MAINNET && (saldoXlm ?? 0n) < 40n * D) throw new Error("saldo XLM bajo: deje al menos 40 XLM para fees, reservas y despliegue");

  // ------------------------------------------------ 1. subyacente
  log("1", `Subyacente: ${MAINNET ? "USDC de Circle" : "USDC de PRUEBA"} y su SAC…`);
  if (!(await existeContrato(sac))) await enviar(firmante, [Operation.createStellarAssetContract({ asset: activo })], { soroban: true });
  if (!MAINNET && ACCION === "pagar") {
    const e = await enviar(firmante, [Operation.changeTrust({ asset: activo }), Operation.payment({ source: emisor.publicKey(), destination: yo, asset: activo, amount: TOTAL.toString() })], { firmantes: [emisor] });
    console.log(`    emision de ${TOTAL} USDC de prueba, tx ${e.hash}`);
  }
  console.log(`    SAC ${sac}`);

  // ------------------------------------------------ 2. pila de contratos
  if (!reutiliza) {
    log("2", "Desplegando pila OpenZeppelin v0.8.0 (verificador, auditor, token)…");
    contratos = { sac, oz: `${man.oz_tag} ${man.oz_commit}`, wasm: {} };
    for (const [k, f] of Object.entries(WASM)) contratos.wasm[k] = (await subirWasm(firmante, f)).toString("hex");
    const ver = await desplegar(firmante, Buffer.from(contratos.wasm.verificador, "hex"), [addr(yo), addr(yo)]);
    contratos.verificador = ver.id;
    contratos.desde_ledger = ver.ledger - 1;
    guardarContratos();
    console.log(`    verificador ${ver.id}  tx ${ver.hash}`);
    for (const [nombre, tipo] of CIRCUITOS_VK) {
      const vk = readFileSync(join(DIR_OZ, "vks", `${nombre}.vk.bin`));
      const r = await invocar(firmante, ver.id, "register_verification_key", [u32(tipo), bytes(vk), addr(yo)]);
      console.log(`      VK ${nombre} (${tipo})  tx ${r.hash}`);
    }
    const aud = await desplegar(firmante, Buffer.from(contratos.wasm.auditor, "hex"), [addr(yo), addr(yo)]);
    contratos.auditor = aud.id;
    guardarContratos();
    const kAud = ct.pointToBytes(ctChain.auditorPublicKey(auditorSk));
    const ra = await invocar(firmante, aud.id, "register_key", [u32(AUDITOR_ID), bytes(kAud), addr(yo)]);
    console.log(`    auditor     ${aud.id}  (llave de Zelena registrada, tx ${ra.hash})`);
    const cumplimiento = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("policy"), val: xdr.ScVal.scvVoid() }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("sac_passthrough"), val: xdr.ScVal.scvBool(false) }),
    ]);
    const tok = await desplegar(firmante, Buffer.from(contratos.wasm.token, "hex"), [addr(yo), addr(sac), addr(ver.id), addr(aud.id), cumplimiento]);
    contratos.token = tok.id;
    contratos.despliegue_tx = tok.hash;
    guardarContratos();
    console.log(`    token       ${tok.id}  tx ${tok.hash}`);
  } else log("2", "Reutilizando la pila desplegada antes.");

  const cliente = new ctChain.ChainClient({
    rpcUrl: CFG.rpc,
    networkPassphrase: CFG.pass,
    contracts: { token: contratos.token, verifier: contratos.verificador, auditor: contratos.auditor },
  });
  const kAud = await cliente.auditorKey(AUDITOR_ID);
  const idEmp = identidad(firmante, contratos.token);
  const idOps = operarios.map((o) => ({ ...o, id: identidad(o.kp, contratos.token) }));

  if (ACCION === "retirar") return retirar(cliente, kAud, firmante, idEmp, idOps, activo);
  if (ACCION !== "pagar") throw new Error(`ACCION desconocida: ${ACCION}`);

  // ------------------------------------------------ 3. operarios
  log("3", "Cuentas y registro confidencial (pruebas UltraHonk v0.8.0 generadas en local)…");
  const ledgerInicio = (await server.getLatestLedger()).sequence;
  if (MAINNET) {
    const faltan = [];
    for (const o of operarios) if (!(await existeCuenta(o.kp.publicKey()))) faltan.push(o);
    if (faltan.length) {
      const r = await enviar(firmante, faltan.map((o) => Operation.createAccount({ destination: o.kp.publicKey(), startingBalance: OPERARIO_XLM })));
      gasto.reservas += BigInt(Math.round(Number(OPERARIO_XLM) * 1e7)) * BigInt(faltan.length);
      console.log(`    ${faltan.length} cuenta(s) de operario creadas con ${OPERARIO_XLM} XLM, tx ${r.hash}`);
    }
  }
  for (const [nombre, id] of [["Empleador", idEmp], ...idOps.map((o) => [o.alias, o.id])]) {
    if (await cliente.isRegistered(id.address)) {
      console.log(`    ${nombre} ya registrado`);
      continue;
    }
    const t0 = Date.now();
    const { payload } = await probarRegistro(id.keys);
    const r = await invocar(id.kp, contratos.token, "register", [addr(id.address), u32(AUDITOR_ID), bytes(payload)]);
    console.log(`    ${nombre} registrado (prueba ${((Date.now() - t0) / 1000).toFixed(1)}s, fee ${xlm(r.fee)} XLM), tx ${r.hash}`);
  }

  // ------------------------------------------------ 4. lote + pagos
  log("4", `Lote: deposito publico de ${TOTAL} USDC al token confidencial + merge…`);
  const dep = await invocar(firmante, contratos.token, "deposit", [addr(yo), addr(yo), i128(TOTAL * D)]);
  console.log(`    deposito tx ${dep.hash}`);
  const mrg = await invocar(firmante, contratos.token, "merge", [addr(yo)]);
  console.log(`    merge    tx ${mrg.hash}`);
  delete llaves.aperturas?.[yo]; // el merge cambia la apertura: se reconstruye de eventos

  log("5", "Pagos confidenciales…");
  const pagos = [];
  for (let i = 0; i < idOps.length; i++) {
    const op = idOps[i];
    const monto = MONTOS[i] * D;
    const ap = await aperturaGastable(cliente, idEmp);
    const t0 = Date.now();
    const tr = await probarTransferencia({ keys: idEmp.keys, v: ap.v, r: ap.r, amount: monto, pvkB: op.id.keys.PVK, kAudR: kAud, kAudS: kAud });
    const r = await invocar(firmante, contratos.token, "confidential_transfer", [addr(yo), addr(op.id.address), bytes(tr.payload)]);
    recordarApertura(yo, tr.next);
    console.log(`    ${op.alias}: ${MONTOS[i]} USDC (prueba ${((Date.now() - t0) / 1000).toFixed(1)}s, fee ${xlm(r.fee)} XLM), tx ${r.hash}`);
    pagos.push({ i, op, monto, hash: r.hash });
  }

  // ------------------------------------------------ 5. verificacion
  log("6", "Verificacion: cada operario lee solo lo suyo; el auditor lee todo…");
  const evs = await eventos(cliente, ledgerInicio);
  for (const p of pagos) {
    const ev = evs.find((e) => e.type === "transfer" && e.to === p.op.id.address);
    if (!ev) throw new Error(`no encontre el evento de transferencia de ${p.op.alias}`);
    const motor = new ct.StateEngine({ address: p.op.id.address, keys: p.op.id.keys });
    motor.ingestEvents(eventosDe(p.op.id.address, evs));
    const propio = motor.receiving().v;
    const otro = idOps[(p.i + 1) % idOps.length];
    let ajeno = false;
    try {
      const intruso = new ct.StateEngine({ address: p.op.id.address, keys: otro.id.keys });
      intruso.ingestEvents(eventosDe(p.op.id.address, evs));
      ajeno = intruso.receiving().v === p.monto;
    } catch {
      ajeno = false;
    }
    const aud = ctChain.auditTransfer(auditorSk, ev);
    const ok = propio === p.monto && !ajeno && aud.amount === p.monto && aud.channelsAgree;
    console.log(
      `    ${p.op.alias}: descifra ${usdc(propio)} USDC ${propio === p.monto ? "OK" : "MAL"} | ${otro.alias} lo abre: ${ajeno ? "SI (MAL)" : "no (OK)"} | auditor ve ${usdc(aud.amount)} ${aud.amount === p.monto && aud.channelsAgree ? "OK" : "MAL"}`,
    );
    console.log(`      ${enlaceTx(p.hash)}`);
    if (!ok) throw new Error(`verificacion fallida para ${p.op.alias}`);
  }

  resumen([["deposito", dep.hash], ["merge", mrg.hash], ...pagos.map((p) => [p.op.alias, p.hash])]);
}

async function retirar(cliente, kAud, firmante, idEmp, idOps, activo) {
  const quien = (process.env.QUIEN || "empleador").toLowerCase();
  const sujeto = quien === "empleador" ? { alias: "Empleador", id: idEmp, generado: false } : idOps[Number(quien.replace(/\D/g, "")) - 1];
  if (!sujeto) throw new Error(`QUIEN invalido: ${quien}`);
  const { id } = sujeto;
  const destino = process.env.DESTINO || id.address;
  log("R1", `Retiro (desenvolver a USDC publico) de ${sujeto.alias} -> ${destino}`);
  if (destino === id.address && id.address !== firmante.publicKey() && (await saldoSac(id.address, contratos.sac, id.address)) === null) {
    const t = await enviar(id.kp, [Operation.changeTrust({ asset: activo })]);
    console.log(`    trustline USDC creada, tx ${t.hash}`);
  }
  let ap = await aperturaGastable(cliente, id);
  const recibiendo = ct.pointToBytes(ap.recibiendo.receivingBalance);
  if (!recibiendo.every((b) => b === 0)) {
    const m = await invocar(id.kp, contratos.token, "merge", [addr(id.address)]);
    console.log(`    merge tx ${m.hash}`);
    delete llaves.aperturas?.[id.address];
    ap = await aperturaGastable(cliente, id);
  }
  const monto = process.env.MONTO ? BigInt(process.env.MONTO) * D : ap.v;
  if (monto <= 0n || monto > ap.v) throw new Error(`monto a retirar invalido (gastable: ${usdc(ap.v)} USDC)`);
  const t0 = Date.now();
  const w = await probarRetiro({ keys: id.keys, v: ap.v, r: ap.r, amount: monto, kAudS: kAud });
  const r = await invocar(id.kp, contratos.token, "withdraw", [addr(id.address), addr(destino), i128(monto), bytes(w.payload)]);
  recordarApertura(id.address, w.next);
  console.log(`    retiro de ${usdc(monto)} USDC (prueba ${((Date.now() - t0) / 1000).toFixed(1)}s), tx ${r.hash}`);
  console.log(`    saldo USDC publico de ${destino}: ${usdc((await saldoSac(firmante.publicKey(), contratos.sac, destino)) ?? 0n)}`);
  resumen([["retiro", r.hash]]);
}

function resumen(txs) {
  console.log(`\n================ RESUMEN (${RED}) ================`);
  for (const k of ["verificador", "auditor", "token"]) console.log(`  ${k.padEnd(12)} ${contratos[k]}  ${enlaceContrato(contratos[k])}`);
  for (const [n, h] of txs) console.log(`  ${n.padEnd(12)} ${enlaceTx(h)}`);
  console.log(`  costo de esta corrida: ${xlm(gasto.fees)} XLM en fees (${gasto.txs} tx)${gasto.reservas ? ` + ${xlm(gasto.reservas)} XLM entregados a cuentas de operario` : ""}`);
  console.log("  Montos cifrados en cadena; el verificador v0.8.0 aun acepta pruebas no-ZK (privacidad no garantizada).");
}

main().catch((e) => {
  console.error("\nERROR: " + (e?.message ?? e));
  if (e?.stack) console.error(e.stack.split("\n").slice(1, 5).join("\n"));
  process.exit(1);
});
