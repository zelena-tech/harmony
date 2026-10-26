/**
 * prover-oz-v080.mjs — Pruebas UltraHonk para los circuitos AUDITADOS de OpenZeppelin
 * stellar-contracts v0.8.0 (crate stellar-confidential).
 *
 * POR QUE EXISTE
 *   stellar-confidential-token-sdk@0.1.9 (npm) trae circuitos ANTERIORES a v0.8.0: sus llaves de
 *   verificacion no coinciden con las fijadas en v0.8.0 y sus pruebas no verifican contra un
 *   verificador v0.8.0. La diferencia de protocolo es una sola: en v0.8.0 el canal
 *   "auditor del emisor" exprime TRES mascaras (SpongeSqueeze_3) y transfer/withdraw publican un
 *   campo nuevo, r_tilde_aud_s = r' + mascara[2] (custodia para el auditor del nuevo cegado del saldo
 *   gastable). El resto de primitivas del SDK reproduce byte a byte los fixtures de v0.8.0
 *   (vk_from_sk, ecdh, derive_spend_r, encrypt_amount, sponge_squeeze_2, address_to_field).
 *
 *   Este modulo reutiliza el SDK (derivacion de llaves, compromisos, ECDH, noir_js + bb.js 0.87.0)
 *   y solo:
 *     1. carga los circuitos v0.8.0 compilados en oz-v0.8.0/circuitos (noir 1.0.0-beta.11; su VK
 *        con bb.js 0.87.0 + keccak es identica byte a byte a packages/confidential/circuits/vks);
 *     2. agrega r_tilde_aud_s al testigo y al payload de transfer y withdraw.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ct = require("stellar-confidential-token-sdk");
const desdeCt = createRequire(require.resolve("stellar-confidential-token-sdk"));
const { permute } = desdeCt("@zkpassport/poseidon2");
const { xdr } = desdeCt("@stellar/stellar-sdk");

const AQUI = dirname(fileURLToPath(import.meta.url));
export const DIR_OZ = join(AQUI, "oz-v0.8.0");

/** Tipos de circuito del verificador (examples/confidential/README.md, paso 3). */
export const CIRCUITOS_VK = [
  ["register", 0],
  ["withdraw", 1],
  ["transfer", 2],
  ["spender_transfer", 3],
  ["set_spender", 4],
  ["clawback", 100],
];

const cache = new Map();
function circuito(nombre) {
  if (!cache.has(nombre)) cache.set(nombre, JSON.parse(readFileSync(join(DIR_OZ, "circuitos", `${nombre}.json`), "utf8")));
  return cache.get(nombre);
}

/** SpongeSqueeze_3 (mismo absorb y permutacion que SpongeSqueeze_2; carril 2 = mascara r_s). */
export function spongeSqueeze3(d, sx, sigma) {
  const iv = ct.frMod(3n * ct.POSEIDON2_IV_BASE);
  const st = permute([d, sx, sigma, iv]);
  return [st[0], st[1], st[2]];
}

const bytesSc = (b) => xdr.ScVal.scvBytes(Buffer.from(b));
const punto = (p) => bytesSc(ct.pointToBytes(p));
const campo = (v) => bytesSc(ct.toBytes32BE(v));
/** Envoltorio XDR { payload, proof } que decodifica el contrato (storage::decode_data). */
function sobre(payload, prueba) {
  return new Uint8Array(ct.scvStruct({ payload: ct.scvStruct(payload), proof: bytesSc(prueba) }).toXDR());
}

async function probar(nombre, inputs) {
  const prover = new ct.CircuitProver(circuito(nombre));
  try {
    const { proof } = await prover.prove(inputs);
    return proof;
  } finally {
    await prover.destroy();
  }
}

/** register: mismo testigo que el SDK (ya incluye _acct_f, auditoria L-06). */
export async function probarRegistro(keys) {
  const w = ct.buildRegisterWitness(keys);
  const prueba = await probar("register", w.inputs);
  return { payload: sobre({ y: punto(w.payload.y), pvk: punto(w.payload.pvk) }, prueba) };
}

/** confidential_transfer v0.8.0: testigo del SDK + r_tilde_aud_s. */
export async function probarTransferencia(params) {
  const w = ct.buildTransferWitness(params);
  const sigma = w.payload.sigma;
  const sAsX = ct.ecdh(w.rEScalar, params.kAudS);
  const m = spongeSqueeze3(ct.DOMAIN.AUDITOR_SENDER, sAsX, sigma);
  if (ct.frAdd(params.amount, m[0]) !== w.payload.vAudS) throw new Error("sponge3 no coincide con el SDK (carril 0)");
  const rAudS = ct.frAdd(w.next.r, m[2]);
  const prueba = await probar("transfer", { ...w.inputs, r_tilde_aud_s: ct.toHex32(rAudS) });
  const p = w.payload;
  const payload = sobre(
    {
      c_spend_new: punto(p.cSpendNew),
      c_transfer: punto(p.cTx),
      r_e_point: punto(p.rE),
      v_tilde: campo(p.vTilde),
      b_tilde: campo(p.bTilde),
      sigma: campo(p.sigma),
      v_tilde_aud_r: campo(p.vAudR),
      r_tilde_aud_r: campo(p.rAudR),
      v_tilde_aud_s: campo(p.vAudS),
      b_tilde_aud_s: campo(p.bAudS),
      r_tilde_aud_s: campo(rAudS),
    },
    prueba,
  );
  return { payload, next: w.next };
}

/** withdraw v0.8.0 (desenvolver a USDC publico): testigo del SDK + r_tilde_aud_s. */
export async function probarRetiro(params) {
  const sigma = params.sigma ?? ct.randomScalar();
  const rE = params.rE ?? ct.randomScalar();
  const w = ct.buildWithdrawWitness({ ...params, sigma, rE });
  const sAsX = ct.ecdh(rE, params.kAudS);
  const m = spongeSqueeze3(ct.DOMAIN.AUDITOR_SENDER, sAsX, sigma);
  const rAudS = ct.frAdd(w.next.r, m[2]);
  const prueba = await probar("withdraw", { ...w.inputs, r_tilde_aud_s: ct.toHex32(rAudS) });
  const p = w.payload;
  const payload = sobre(
    {
      c_spend_new: punto(p.cSpendNew),
      b_tilde: campo(p.bTilde),
      r_e_point: punto(p.rE),
      sigma: campo(p.sigma),
      b_tilde_aud_s: campo(p.bAudS),
      r_tilde_aud_s: campo(rAudS),
    },
    prueba,
  );
  return { payload, next: w.next };
}
