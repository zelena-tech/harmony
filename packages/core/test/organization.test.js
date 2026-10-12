'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('@stellar/stellar-sdk');
const { defineTenant } = require('../src/tenant');
const { createOrganizationClient, keypairSigner, enumTag, arg } = require('../src/soroban/organization');

const CONTRACT = sdk.StrKey.encodeContract(Buffer.alloc(32, 7));
const tenant = defineTenant({ id: 'acme', network: 'testnet', contracts: { organization: CONTRACT } });

test('enum arguments are encoded as the contract expects (vec with one symbol)', () => {
  assert.deepEqual(sdk.scValToNative(arg.enumUnit('Worker')), ['Worker']);
  assert.equal(enumTag(['Completed']), 'Completed');
  assert.equal(enumTag({ tag: 'Approved' }), 'Approved');
  assert.equal(enumTag(null), null);
});

test('keypairSigner signs with the given key', async () => {
  const kp = sdk.Keypair.random();
  const s = keypairSigner(kp.secret());
  const t = new sdk.TransactionBuilder(new sdk.Account(kp.publicKey(), '1'), { fee: '100', networkPassphrase: sdk.Networks.TESTNET })
    .addOperation(sdk.Operation.bumpSequence({ bumpTo: '2' })).setTimeout(30).build();
  const signed = sdk.TransactionBuilder.fromXDR(await s.signTransaction(t.toXDR(), { networkPassphrase: sdk.Networks.TESTNET }), sdk.Networks.TESTNET);
  assert.equal(signed.signatures.length, 1);
  assert.equal(s.publicKey, kp.publicKey());
});

test('the client is bound to the tenant contract and refuses missing configuration', () => {
  const src = sdk.Keypair.random().publicKey();
  assert.equal(createOrganizationClient({ tenant, sourcePublicKey: src }).contractId, CONTRACT);
  const noContract = defineTenant({ id: 'acme', network: 'testnet' });
  assert.throws(() => createOrganizationClient({ tenant: noContract, sourcePublicKey: src }), /no organization contract/);
  const mainnet = defineTenant({ id: 'acme', network: 'mainnet', contracts: { organization: CONTRACT } });
  assert.throws(() => createOrganizationClient({ tenant: mainnet, sourcePublicKey: src }), /no Soroban RPC URL/);
});

test('read() simulates against the tenant contract and decodes the result', async () => {
  const src = sdk.Keypair.random().publicKey();
  let simulated = null;
  const rpc = {
    getAccount: async (id) => new sdk.Account(id, '1'),
    simulateTransaction: async (t) => { simulated = t; return { result: { retval: sdk.nativeToScVal(false) } }; },
  };
  const client = createOrganizationClient({ tenant, sourcePublicKey: src, rpc });
  assert.equal(await client.isPaused(), false);
  const op = simulated.operations[0];
  assert.equal(op.type, 'invokeHostFunction');
  assert.equal(sdk.StrKey.encodeContract(op.func.invokeContract().contractAddress().contractId()), CONTRACT);
  assert.equal(op.func.invokeContract().functionName().toString(), 'is_paused');
});

test('invoke() requires a signer', async () => {
  const client = createOrganizationClient({ tenant, sourcePublicKey: sdk.Keypair.random().publicKey(), rpc: {} });
  await assert.rejects(client.invoke('pause', []), /needs signTransaction/);
});
