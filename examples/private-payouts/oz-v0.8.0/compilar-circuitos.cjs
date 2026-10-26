/**
 * compilar-circuitos.cjs — Reproduce oz-v0.8.0/circuitos/*.json desde las fuentes de OpenZeppelin
 * stellar-contracts v0.8.0 y comprueba que la VK de cada circuito (bb.js 0.87.0, transcript keccak)
 * es identica byte a byte a la VK fijada por OZ (packages/confidential/circuits/vks/*.vk.bin).
 *
 * No es necesario para pagar: los .json ya estan en el repo. Sirve para auditar que lo que firmamos
 * es exactamente el circuito auditado.
 *
 * USO (desde herramientas/pago-privado, tras npm install)
 *   git clone --depth 1 --branch v0.8.0 https://github.com/OpenZeppelin/stellar-contracts.git <dir>
 *   npm i --no-save @noir-lang/noir_wasm@1.0.0-beta.11
 *   OZ_CIRCUITOS=<dir>/packages/confidential/circuits node oz-v0.8.0/compilar-circuitos.cjs
 *
 * No hay nargo para Windows: se usa noir_wasm. En Windows noir_wasm mezcla "\" y "/", por eso se le
 * da path.posix y un sistema de archivos virtual que mapea /circ -> disco.
 */
const Module = require("module");
const pathReal = require("path");
const cargaOriginal = Module._load;
Module._load = function (req, padre, ...resto) {
  if (req === "path" && padre && /noir_wasm/.test(padre.filename)) return pathReal.posix;
  return cargaOriginal.call(this, req, padre, ...resto);
};
const { compile_program, createFileManager } = require("@noir-lang/noir_wasm");
const fs = require("fs");
const path = require("path");

const CIRC = (process.env.OZ_CIRCUITOS || "").replace(/\\/g, "/");
if (!CIRC || !fs.existsSync(path.join(CIRC, "vks"))) throw new Error("OZ_CIRCUITOS debe apuntar a packages/confidential/circuits de OZ v0.8.0");
const SALIDA = path.join(__dirname, "circuitos");
const disco = (p) => (p.startsWith("/circ") ? CIRC + p.slice(5) : p);
const vfs = {
  existsSync: (p) => fs.existsSync(disco(p)),
  mkdir: async () => {},
  writeFile: async () => {},
  readFile: (p, enc) => fs.promises.readFile(disco(p), enc),
  rename: async () => {},
  readdir: async (dir, o) => {
    const recorrer = (d) => fs.readdirSync(disco(d)).flatMap((h) => (fs.statSync(disco(d + "/" + h)).isFile() ? [d + "/" + h] : recorrer(d + "/" + h)));
    return o?.recursive ? recorrer(dir) : fs.readdirSync(disco(dir));
  },
};

(async () => {
  const bbRuta = require.resolve("@aztec/bb.js", { paths: [path.dirname(require.resolve("stellar-confidential-token-sdk"))] });
  const { UltraHonkBackend } = require(bbRuta);
  let todoOk = true;
  for (const nombre of ["register", "transfer", "withdraw"]) {
    const fm = new (createFileManager("/").constructor)(vfs, "/");
    const { program } = await compile_program(fm, "/circ/" + nombre, () => {}, () => {});
    const be = new UltraHonkBackend(program.bytecode);
    const vk = Buffer.from(await be.getVerificationKey({ keccak: true }));
    await be.destroy();
    const fijada = fs.readFileSync(path.join(CIRC, "vks", `${nombre}.vk.bin`));
    const igual = Buffer.compare(vk.subarray(0, fijada.length), fijada) === 0;
    todoOk &&= igual;
    fs.writeFileSync(path.join(SALIDA, `${nombre}.json`), JSON.stringify({ noir_version: program.noir_version, hash: program.hash, abi: program.abi, bytecode: program.bytecode }));
    console.log(`${nombre}: noir ${program.noir_version}, VK ${igual ? "IDENTICA a la fijada por OZ" : "DISTINTA (no usar)"}`);
  }
  process.exit(todoOk ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
