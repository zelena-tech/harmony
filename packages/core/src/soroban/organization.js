'use strict';

const sdk = require('@stellar/stellar-sdk');

/**
 * Client for one tenant's Organization contract.
 *
 * Signing is delegated: `signTransaction(xdr, { networkPassphrase })` must
 * return the signed XDR. It has the same shape as Freighter's signTransaction,
 * so the same client works in a browser (the user signs) and in a script
 * (keypairSigner). The client never reads keys from the environment.
 *
 * Flow of `invoke`: build → simulate → assemble → sign → send → poll.
 */

const POLL_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 3000;
const BASE_FEE = '2000';

const arg = {
  address: (a) => new sdk.Address(a).toScVal(),
  u32: (v) => sdk.nativeToScVal(v, { type: 'u32' }),
  u64: (v) => sdk.nativeToScVal(v, { type: 'u64' }),
  i128: (v) => sdk.nativeToScVal(v, { type: 'i128' }),
  string: (v) => sdk.nativeToScVal(v, { type: 'string' }),
  bool: (v) => sdk.nativeToScVal(v, { type: 'bool' }),
  // Unit enum variants (Role::Worker…) are encoded as a vec with one symbol.
  enumUnit: (tag) => sdk.xdr.ScVal.scvVec([sdk.xdr.ScVal.scvSymbol(tag)]),
};

/** scValToNative returns unit enum variants as ['Completed']; this returns 'Completed'. */
function enumTag(raw) {
  if (Array.isArray(raw)) return raw[0];
  return raw?.tag ?? raw ?? null;
}

/**
 * Signer backed by a secret key. For scripts and tests only: a web server should
 * let each person sign in their own wallet instead of holding keys.
 */
function keypairSigner(secret) {
  const kp = sdk.Keypair.fromSecret(secret);
  return {
    publicKey: kp.publicKey(),
    signTransaction: async (xdr, { networkPassphrase }) => {
      const tx = sdk.TransactionBuilder.fromXDR(xdr, networkPassphrase);
      tx.sign(kp);
      return tx.toXDR();
    },
  };
}

/**
 * @param {object} opts
 * @param {object} opts.tenant                 defineTenant() result (network, rpcUrl, contracts.organization)
 * @param {string} opts.sourcePublicKey        account that pays the fee and signs
 * @param {Function} [opts.signTransaction]    required for invoke(), not for read()
 * @param {object} [opts.rpc]                  injectable rpc.Server (tests)
 * @param {string} [opts.contractId]           overrides tenant.contracts.organization
 */
function createOrganizationClient({ tenant, sourcePublicKey, signTransaction, rpc, contractId }) {
  const id = contractId || tenant.contracts.organization;
  if (!id) throw new Error(`Tenant ${tenant.id} has no organization contract`);
  if (!tenant.rpcUrl && !rpc) throw new Error(`Tenant ${tenant.id} has no Soroban RPC URL`);
  const server = rpc || new sdk.rpc.Server(tenant.rpcUrl);
  const contract = new sdk.Contract(id);
  const passphrase = tenant.networkPassphrase;

  async function build(method, args) {
    const source = await server.getAccount(sourcePublicKey);
    return new sdk.TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(contract.call(method, ...args))
      .setTimeout(300)
      .build();
  }

  /** Simulation only: no fee, no sequence change. Returns the native value. */
  async function read(method, args = []) {
    const sim = await server.simulateTransaction(await build(method, args));
    if (sdk.rpc.Api.isSimulationError(sim)) throw new Error(`Simulation failed [${method}]: ${sim.error}`);
    return sdk.scValToNative(sim.result.retval);
  }

  /** Signed invocation. Returns { hash, returnValue } once the ledger confirms it. */
  async function invoke(method, args = []) {
    if (typeof signTransaction !== 'function') throw new Error('invoke() needs signTransaction');
    const tx = await build(method, args);
    const sim = await server.simulateTransaction(tx);
    if (sdk.rpc.Api.isSimulationError(sim)) throw new Error(`Simulation failed [${method}]: ${sim.error}`);
    const assembled = sdk.rpc.assembleTransaction(tx, sim).build();
    const signedXdr = await signTransaction(assembled.toXDR(), { networkPassphrase: passphrase });
    const signed = sdk.TransactionBuilder.fromXDR(signedXdr, passphrase);
    const sent = await server.sendTransaction(signed);
    if (sent.status === 'ERROR') throw new Error(`Send failed [${method}]: ${JSON.stringify(sent.errorResult)}`);
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const res = await server.getTransaction(sent.hash);
      if (res.status === 'SUCCESS') {
        return { hash: sent.hash, returnValue: res.returnValue ? sdk.scValToNative(res.returnValue) : null };
      }
      if (res.status !== 'NOT_FOUND') throw new Error(`Transaction ${sent.hash} [${method}] failed: ${res.status}`);
    }
    throw new Error(`Timeout: transaction ${sent.hash} [${method}] not confirmed`);
  }

  const me = sourcePublicKey;
  return {
    contractId: id,
    read,
    invoke,
    // Typed wrappers. `caller` defaults to the source account.
    openPeriod: (start, end, caller = me) => invoke('open_period', [arg.address(caller), arg.u64(start), arg.u64(end)]),
    closePeriod: (periodId, caller = me) => invoke('close_period', [arg.address(caller), arg.u32(periodId)]),
    createTemplate: (name, basePoints, caller = me) => invoke('create_template', [arg.address(caller), arg.string(name), arg.u32(basePoints)]),
    addMember: (member, role, caller = me) => invoke('add_member', [arg.address(caller), arg.address(member), arg.enumUnit(role)]),
    createTask: (worker, templateId, periodId, caller = me) =>
      invoke('create_task', [arg.address(caller), arg.address(worker), arg.u32(templateId), arg.u32(periodId)]),
    completeTask: (taskId, evidenceUrl, worker = me) => invoke('complete_task', [arg.address(worker), arg.u32(taskId), arg.string(evidenceUrl)]),
    reviewTask: (taskId, approved, multiplierBp = 10000, caller = me) =>
      invoke('review_task', [arg.address(caller), arg.u32(taskId), arg.bool(approved), arg.u32(multiplierBp)]),
    fundPeriod: (periodId, amountStroops, funder = me, caller = me) =>
      invoke('fund_period', [arg.address(caller), arg.address(funder), arg.u32(periodId), arg.i128(BigInt(amountStroops))]),
    distributeRewards: (periodId, caller = me) => invoke('distribute_rewards', [arg.address(caller), arg.u32(periodId)]),
    claimReward: (periodId, worker = me) => invoke('claim_reward', [arg.address(worker), arg.u32(periodId)]),
    getPeriod: (periodId) => read('get_period', [arg.u32(periodId)]),
    getTask: (taskId) => read('get_task', [arg.u32(taskId)]),
    getWorkerStats: (periodId, worker) => read('get_worker_stats', [arg.u32(periodId), arg.address(worker)]),
    getOwner: () => read('get_owner'),
    isPaused: () => read('is_paused'),
  };
}

module.exports = { createOrganizationClient, keypairSigner, enumTag, arg };
