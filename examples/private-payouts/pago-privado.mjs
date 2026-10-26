/**
 * harmony-pago-privado.mjs — Demo REAL de pago privado de bonos Harmony en Stellar TESTNET.
 *
 * QUE HACE
 *   Paga los bonos de desempeno de 3 operarios ("Operario 01/02/03") con un token
 *   confidencial de OpenZeppelin (SEP-41 confidencial: compromisos de Pedersen +
 *   pruebas UltraHonk). En cadena se ven las direcciones, pero NO los montos:
 *   ningun operario puede ver cuanto recibio otro. Paso a paso:
 *     1. Crea (o recarga) las cuentas: empleador, emisor del USDC de prueba,
 *        y 3 operarios; las fondea con friendbot (XLM de testnet).
 *     2. Emite un activo clasico "USDC" de PRUEBA desde un emisor propio de testnet
 *        y despliega su Stellar Asset Contract (SAC). No es USDC real.
 *     3. Despliega NUESTRA instancia del registro de auditor (llave de auditor de
 *        Zelena, generada aqui) y NUESTRA instancia del token confidencial que
 *        envuelve ese USDC de prueba. Reutiliza los wasm ya publicados en testnet
 *        por el SDK de referencia (stellar-confidential-token-sdk) y su verificador
 *        UltraHonk, que tiene registradas las llaves de verificacion de los circuitos.
 *     4. Registra al empleador y a los 3 operarios en el token (prueba UltraHonk real
 *        generada localmente con @aztec/bb.js), deposita 55 USDC de prueba (deposito
 *        publico: es el "lote"), los pasa a saldo gastable (merge) y hace 3
 *        transferencias confidenciales: 20, 18 y 17 USDC.
 *     5. Verifica que cada operario descifra SOLO su propio saldo (y que con su llave
 *        no puede abrir el de otro), que el auditor de Zelena puede leer los 3 montos,
 *        y que el estado local coincide con los compromisos en cadena.
 *     6. Escribe salida/demo.json (o SALIDA_DEMO) con el contrato y los hashes
 *        reales (lo lee la pantalla de Harmony).
 *
 * SOLO TESTNET
 *   Nunca mainnet ni USDC real. El verificador actual de OpenZeppelin v0.8.0 acepta
 *   pruebas UltraHonk no zero-knowledge, asi que la privacidad no esta garantizada
 *   todavia. Esto es una demo.
 *
 * LLAVES
 *   Las llaves secretas de testnet (cuentas y llave del auditor) se guardan en
 *   herramientas/pago-privado/.pago-privado-keys.json, que esta en .gitignore. NUNCA se commitea.
 *
 * COMO SE CORRE
 *   cd examples/private-payouts
 *   npm install            # instala stellar-confidential-token-sdk (fijado en 0.1.9)
 *   npm install && node pago-privado.mjs
 *   # Opcional: NUEVO=1 MONTOS="4,3,3" node pago-privado.mjs  -> cuentas y contratos nuevos, 10 USDC
 *   Tarda unos minutos (7 pruebas UltraHonk generadas en local).
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Todo se carga como CommonJS y @stellar/stellar-sdk se resuelve DESDE el SDK
// confidencial (fija la 16.2.0), para que las clases XDR sean la misma instancia
// que usa el SDK (el backend usa la 14.x).
const require = createRequire(import.meta.url);
const ct = require("stellar-confidential-token-sdk");
const ctNode = require("stellar-confidential-token-sdk/node");
const ctChain = require("stellar-confidential-token-sdk/chain");
const requireDesdeCt = createRequire(require.resolve("stellar-confidential-token-sdk"));
const S = requireDesdeCt("@stellar/stellar-sdk");
const { Keypair, Networks, Address, Asset, Operation, TransactionBuilder, BASE_FEE, nativeToScVal, xdr, rpc } = S;

const AQUI = dirname(fileURLToPath(import.meta.url));
const ARCHIVO_LLAVES = join(AQUI, ".pago-privado-keys.json");
const ARCHIVO_DEMO = process.env.SALIDA_DEMO || join(AQUI, "salida", "demo.json");

const RPC_URL = "https://soroban-testnet.stellar.org";
const RED = Networks.TESTNET;
const EXPLORADOR = "https://stellar.expert/explorer/testnet";

// Contratos de referencia ya publicados en testnet por stellar-confidential-token-sdk
// (OpenZeppelin confidential token). Del token y del auditor solo tomamos el WASM;
// el verificador (registro de llaves de verificacion UltraHonk) se comparte.
const REF = {
  token: "CBFOJTALVTO3LPZZHEXDD44K7RQKQJGAASF6XOKP5FWZD6WYKV4WN7HF",
  verificador: "CBXEPTSEC3433EH3TKUZSSZCIWIDMGZDY2FB7BN5IJ76A2JISQF4YTN6",
  auditor: "CDCPR4AURWJQRY4KXSRU7H7ABKIHTDORSQABIOUH37DU3IGYV5LRCHEK",
};
const AUDITOR_ID = 0;
const DECIMALES = 10_000_000n; // activos clasicos de Stellar: 7 decimales

// Montos en USDC enteros, uno por operario: MONTOS="4,3,3" (por defecto 20,18,17).
const MONTOS = (process.env.MONTOS || "20,18,17").split(",").map((m) => BigInt(m.trim()));
const PAGOS = MONTOS.map((usdc, i) => ({ alias: `Operario ${String(i + 1).padStart(2, "0")}`, usdc }));
const TOTAL = PAGOS.reduce((s, p) => s + p.usdc, 0n);

const server = new rpc.Server(RPC_URL);
const log = (paso, msg) => console.log(`\n[${paso}] ${msg}`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString("hex");
const abreviar = (h) => `0x${h.slice(0, 8)}…${h.slice(-6)}`;

// ---------------------------------------------------------------- llaves

function cargarLlaves() {
  if (!process.env.NUEVO && existsSync(ARCHIVO_LLAVES)) {
    return JSON.parse(readFileSync(ARCHIVO_LLAVES, "utf8"));
  }
  const nueva = () => Keypair.random().secret();
  // Llave de auditor de Zelena: escalar aleatorio < orden de Grumpkin (FR del SDK).
  const azar = BigInt("0x" + hex(crypto.getRandomValues(new Uint8Array(32))));
  const llaves = {
    nota: "SOLO TESTNET. Archivo ignorado por git. No commitear.",
    empleador: nueva(),
    emisor_usdc: nueva(),
    operarios: PAGOS.map((p) => ({ alias: p.alias, secreto: nueva() })),
    auditor_sk: ((azar % ((ct.FR_MODULUS < ct.FP_MODULUS ? ct.FR_MODULUS : ct.FP_MODULUS) - 1n)) + 1n).toString(),
    contratos: {},
  };
  guardarLlaves(llaves);
  return llaves;
}
function guardarLlaves(llaves) {
  writeFileSync(ARCHIVO_LLAVES, JSON.stringify(llaves, null, 2));
}

// ---------------------------------------------------------------- envio de transacciones

async function fondear(pub) {
  try {
    await server.getAccount(pub);
    return; // ya existe
  } catch {}
  const res = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  if (!res.ok && res.status !== 400) throw new Error(`friendbot fallo para ${pub}: ${res.status}`);
}

async function esperar(hash) {
  for (let i = 0; i < 60; i++) {
    const r = await server.getTransaction(hash);
    if (r.status === "SUCCESS") return r;
    if (r.status === "FAILED") throw new Error(`tx ${hash} FALLO`);
    await dormir(1000);
  }
  throw new Error(`tx ${hash} sin confirmar`);
}

/** Construye, simula (si es Soroban), firma y envia una transaccion con 1+ operaciones. */
async function enviar(fuente, operaciones, { soroban = false, firmantes = [] } = {}) {
  const cuenta = await server.getAccount(fuente.publicKey());
  let tx = new TransactionBuilder(cuenta, { fee: (BigInt(BASE_FEE) * 100n).toString(), networkPassphrase: RED });
  for (const op of operaciones) tx = tx.addOperation(op);
  tx = tx.setTimeout(120).build();
  if (soroban) tx = await server.prepareTransaction(tx);
  tx.sign(fuente, ...firmantes);
  const env = await server.sendTransaction(tx);
  if (env.status === "ERROR") throw new Error(`envio rechazado: ${JSON.stringify(env.errorResult?.result?.()?.switch?.()?.name ?? env)}`);
  const r = await esperar(env.hash);
  return { hash: env.hash, retorno: r.returnValue, ledger: r.ledger };
}

async function wasmHashDe(contractId) {
  const llave = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const { entries } = await server.getLedgerEntries(llave);
  if (!entries.length) throw new Error(`contrato ${contractId} no existe en testnet`);
  return entries[0].val.contractData().val().instance().executable().wasmHash();
}

async function existeContrato(contractId) {
  try {
    await wasmHashDe(contractId);
    return true;
  } catch {
    return false;
  }
}

async function desplegar(fuente, wasmHash, argsConstructor) {
  const op = Operation.createCustomContract({
    address: new Address(fuente.publicKey()),
    wasmHash,
    constructorArgs: argsConstructor,
    salt: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
  });
  const r = await enviar(fuente, [op], { soroban: true });
  return { id: Address.fromScVal(r.retorno).toString(), hash: r.hash, ledger: r.ledger };
}

// ---------------------------------------------------------------- helpers del token confidencial

const addr = (a) => new Address(a).toScVal();
const u32 = (n) => xdr.ScVal.scvU32(n);
const i128 = (v) => nativeToScVal(v, { type: "i128" });
const bytes = (b) => xdr.ScVal.scvBytes(Buffer.from(b));

/** Identidad confidencial derivada de la firma de la cuenta (SDK.md §5.1): nada se guarda. */
function identidad(kp, token) {
  const mensaje = ct.skSigningMessage(token, kp.publicKey());
  const raiz = new Uint8Array(kp.signMessage(Buffer.from(mensaje)));
  const { sk, addrF } = ct.deriveSk(raiz, token, kp.publicKey());
  return { keys: ct.deriveKeys(sk, addrF, ct.addressToField(kp.publicKey())), address: kp.publicKey(), kp };
}

function eventosDe(direccion, eventos) {
  return eventos.filter((ev) => {
    switch (ev.type) {
      case "register":
      case "merge":
        return ev.account === direccion;
      case "deposit":
      case "withdraw":
      case "transfer":
        return ev.from === direccion || ev.to === direccion;
      default:
        return false;
    }
  });
}

async function todosLosEventos(cliente, desdeLedger) {
  const { events } = await ctChain.hybridFetchEvents(cliente, undefined, { fromLedger: desdeLedger });
  return events;
}

async function reconstruir(cliente, desdeLedger, direccion, keys) {
  const motor = new ct.StateEngine({ address: direccion, keys });
  motor.ingestEvents(eventosDe(direccion, await todosLosEventos(cliente, desdeLedger)));
  return motor;
}

// ---------------------------------------------------------------- flujo

async function main() {
  const llaves = cargarLlaves();
  const empleador = Keypair.fromSecret(llaves.empleador);
  const emisor = Keypair.fromSecret(llaves.emisor_usdc);
  const operarios = llaves.operarios.map((o) => ({ alias: o.alias, kp: Keypair.fromSecret(o.secreto) }));
  const auditorSk = BigInt(llaves.auditor_sk);

  log("1", "Fondeando cuentas de testnet con friendbot…");
  await Promise.all([empleador, emisor, ...operarios.map((o) => o.kp)].map((k) => fondear(k.publicKey())));
  console.log(`    empleador ${empleador.publicKey()}`);
  operarios.forEach((o) => console.log(`    ${o.alias} ${o.kp.publicKey()}`));

  log("2", "USDC de PRUEBA: activo clasico propio de testnet + su SAC…");
  const usdc = new Asset("USDC", emisor.publicKey());
  const sacId = usdc.contractId(RED);
  if (!(await existeContrato(sacId))) {
    await enviar(empleador, [Operation.createStellarAssetContract({ asset: usdc })], { soroban: true });
  }
  // Trustline del empleador + emision de 55 USDC de prueba (una sola transaccion).
  const emision = await enviar(
    empleador,
    [
      Operation.changeTrust({ asset: usdc }),
      Operation.payment({ source: emisor.publicKey(), destination: empleador.publicKey(), asset: usdc, amount: TOTAL.toString() }),
    ],
    { firmantes: [emisor] },
  );
  console.log(`    SAC ${sacId}`);
  console.log(`    emision de ${TOTAL} USDC de prueba al empleador, tx ${emision.hash}`);

  log("3", "Desplegando registro de auditor de Zelena y token confidencial propio…");
  let c = llaves.contratos ?? {};
  if (!c.token || !(await existeContrato(c.token))) {
    const [wasmAuditor, wasmToken] = await Promise.all([wasmHashDe(REF.auditor), wasmHashDe(REF.token)]);
    const aud = await desplegar(empleador, wasmAuditor, [addr(empleador.publicKey()), addr(empleador.publicKey())]);
    const puntoAuditor = ct.pointToBytes(ctChain.auditorPublicKey(auditorSk));
    await enviar(empleador, [
      Operation.invokeContractFunction({
        contract: aud.id,
        function: "register_key",
        args: [u32(AUDITOR_ID), xdr.ScVal.scvBytes(Buffer.from(puntoAuditor)), addr(empleador.publicKey())],
      }),
    ], { soroban: true });
    const tok = await desplegar(empleador, wasmToken, [addr(sacId), addr(REF.verificador), addr(aud.id)]);
    c = { auditor: aud.id, token: tok.id, sac: sacId, verificador: REF.verificador, desde_ledger: aud.ledger - 1, despliegue_tx: tok.hash };
    llaves.contratos = c;
    guardarLlaves(llaves);
  }
  console.log(`    auditor ${c.auditor}`);
  console.log(`    token   ${c.token}  (envuelve ${sacId})`);

  const cliente = new ctChain.ChainClient({
    rpcUrl: RPC_URL,
    networkPassphrase: RED,
    contracts: { token: c.token, verifier: c.verificador, auditor: c.auditor },
  });
  const firmante = (kp) => ctChain.keypairSigner(kp.secret(), RED);
  const idEmp = identidad(empleador, c.token);
  const idOps = operarios.map((o) => ({ ...o, id: identidad(o.kp, c.token) }));
  const kAud = await cliente.auditorKey(AUDITOR_ID);

  log("4", "Registro confidencial (pruebas UltraHonk reales generadas en local)…");
  for (const [nombre, id] of [["Empleador", idEmp], ...idOps.map((o) => [o.alias, o.id])]) {
    if (await cliente.isRegistered(id.address)) {
      console.log(`    ${nombre} ya registrado`);
      continue;
    }
    const t0 = Date.now();
    const { payload } = await ctNode.proveRegister(id.keys);
    const r = await cliente.invoke(c.token, "register", [addr(id.address), u32(AUDITOR_ID), bytes(payload)], firmante(id.kp));
    console.log(`    ${nombre} registrado (prueba ${((Date.now() - t0) / 1000).toFixed(1)}s), tx ${r.hash}`);
  }

  log("5", `Lote: deposito publico de ${TOTAL} USDC de prueba al token confidencial + merge…`);
  const dep = await cliente.invoke(c.token, "deposit", [addr(empleador.publicKey()), addr(empleador.publicKey()), i128(TOTAL * DECIMALES)], firmante(empleador));
  console.log(`    deposito tx ${dep.hash}`);
  const mrg = await cliente.invoke(c.token, "merge", [addr(empleador.publicKey())], firmante(empleador));
  console.log(`    merge tx ${mrg.hash}`);

  log("6", "Pagos confidenciales a los operarios…");
  const pagos = [];
  for (let i = 0; i < idOps.length; i++) {
    const op = idOps[i];
    const monto = PAGOS[i].usdc * DECIMALES;
    const estado = (await reconstruir(cliente, c.desde_ledger, empleador.publicKey(), idEmp.keys)).state();
    const t0 = Date.now();
    const tr = await ctNode.proveTransfer({
      keys: idEmp.keys,
      v: estado.spendable.v,
      r: estado.spendable.r,
      amount: monto,
      pvkB: op.id.keys.PVK,
      kAudR: kAud,
      kAudS: kAud,
    });
    const r = await cliente.invoke(c.token, "confidential_transfer", [addr(empleador.publicKey()), addr(op.id.address), bytes(tr.payload)], firmante(empleador));
    console.log(`    ${op.alias}: ${PAGOS[i].usdc} USDC (prueba ${((Date.now() - t0) / 1000).toFixed(1)}s), tx ${r.hash}`);
    pagos.push({ i, op, monto, hash: r.hash });
  }

  log("7", "Verificacion: cada operario lee solo lo suyo; el auditor lee todo…");
  const eventos = await todosLosEventos(cliente, c.desde_ledger);
  const transferencias = eventos.filter((e) => e.type === "transfer");
  const resultado = [];
  for (const p of pagos) {
    const ev = transferencias.find((e) => e.to === p.op.id.address);
    if (!ev) throw new Error(`no encontre el evento de transferencia de ${p.op.alias}`);

    // a) El propio operario descifra su saldo recibido con su llave.
    const motor = new ct.StateEngine({ address: p.op.id.address, keys: p.op.id.keys });
    motor.ingestEvents(eventosDe(p.op.id.address, eventos));
    const propio = motor.receiving().v;
    const enCadena = await cliente.confidentialBalance(p.op.id.address);
    const cuadra = motor.verifyAgainstChain({
      spendableC: ct.pointToBytes(enCadena.spendableBalance),
      receivingC: ct.pointToBytes(enCadena.receivingBalance),
    });

    // b) Otro operario intenta abrir ESTE saldo con SU llave: no debe poder.
    const otro = idOps[(p.i + 1) % idOps.length];
    let ajenoAbre = false;
    try {
      const intruso = new ct.StateEngine({ address: p.op.id.address, keys: otro.id.keys });
      intruso.ingestEvents(eventosDe(p.op.id.address, eventos));
      const v = intruso.receiving().v;
      const chk = intruso.verifyAgainstChain({
        spendableC: ct.pointToBytes(enCadena.spendableBalance),
        receivingC: ct.pointToBytes(enCadena.receivingBalance),
      });
      ajenoAbre = v === p.monto && chk.ok;
    } catch {
      ajenoAbre = false;
    }

    // c) El auditor de Zelena descifra el monto con su llave de vista.
    const aud = ctChain.auditTransfer(auditorSk, ev);

    console.log(
      `    ${p.op.alias}: descifra ${propio / DECIMALES} USDC ${propio === p.monto ? "OK" : "MAL"} | cuadra con cadena ${cuadra.ok ? "OK" : "MAL"} | ${otro.alias} lo abre: ${ajenoAbre ? "SI (MAL)" : "no (OK)"} | auditor ve ${aud.amount / DECIMALES} ${aud.amount === p.monto && aud.channelsAgree ? "OK" : "MAL"}`,
    );
    if (propio !== p.monto || !cuadra.ok || ajenoAbre || aud.amount !== p.monto) {
      throw new Error(`verificacion fallida para ${p.op.alias}`);
    }
    const vTilde = ev.vTilde.toString(16).padStart(64, "0");
    resultado.push({
      alias: p.op.alias,
      monto_usdc: Number(PAGOS[p.i].usdc),
      tx: p.hash,
      explorador: `${EXPLORADOR}/tx/${p.hash}`,
      en_cadena: `monto cifrado ${abreviar(vTilde)} (solo el operario y el auditor pueden leerlo)`,
    });
  }

  log("8", "Escribiendo demo.json…");
  const demo = {
    red: "testnet",
    generado: new Date().toISOString(),
    token: {
      contrato: c.token,
      subyacente: "USDC de prueba (testnet)",
      explorador: `${EXPLORADOR}/contract/${c.token}`,
    },
    lote: { total_usdc: Number(TOTAL), tx: dep.hash, explorador: `${EXPLORADOR}/tx/${dep.hash}` },
    pagos: resultado,
    auditor: {
      puede_ver: true,
      nota: "La llave de auditor de Zelena descifro los 3 montos desde la cadena; ningun operario puede abrir el saldo de otro.",
    },
    advertencia:
      "Testnet. El verificador actual de OpenZeppelin v0.8.0 acepta pruebas no zero-knowledge: la privacidad total llega con la verificación ZK.",
  };
  mkdirSync(dirname(ARCHIVO_DEMO), { recursive: true });
  writeFileSync(ARCHIVO_DEMO, JSON.stringify(demo, null, 2) + "\n");
  console.log(`    ${ARCHIVO_DEMO}`);
  console.log("\nListo: pago privado real en testnet. Los montos nunca aparecieron en claro en cadena.");
}

main().catch((e) => {
  console.error("\nERROR: " + (e?.message ?? e));
  if (e?.stack) console.error(e.stack.split("\n").slice(1, 5).join("\n"));
  process.exit(1);
});
