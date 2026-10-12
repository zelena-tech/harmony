'use strict';

const sdk = require('@stellar/stellar-sdk');

/**
 * Network constants. Every value can be overridden per tenant
 * (see tenant.js); nothing here is read from the environment.
 *
 * USDC issuers:
 *  - mainnet: Circle's issuer.
 *  - testnet: the issuer of the testnet USDC used by the Stellar test anchors.
 */
const NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    name: 'mainnet',
    passphrase: sdk.Networks.PUBLIC,
    horizonUrl: 'https://horizon.stellar.org',
    rpcUrl: null, // mainnet has no public SDF RPC: the tenant must provide one
    usdcIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  }),
  testnet: Object.freeze({
    name: 'testnet',
    passphrase: sdk.Networks.TESTNET,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  }),
});

/** Stellar enforces at most 100 operations per transaction; payouts use 20 per batch. */
const PAYMENTS_PER_TX = 20;

function network(name) {
  const n = NETWORKS[String(name || '').toLowerCase()];
  if (!n) throw new Error(`Unsupported Stellar network: ${name}`);
  return n;
}

const isAccountId = (s) => sdk.StrKey.isValidEd25519PublicKey(String(s || ''));
const isContractId = (s) => sdk.StrKey.isValidContract(String(s || ''));

/** Rounds to 7 decimals (1 stroop), the precision of Stellar amounts. */
const toStroopPrecision = (n) => Number(Number(n).toFixed(7));

module.exports = { NETWORKS, PAYMENTS_PER_TX, network, isAccountId, isContractId, toStroopPrecision };
