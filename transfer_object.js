import TransportNodeHidModule from '@ledgerhq/hw-transport-node-hid';
import SuiLedgerClient from '@mysten/ledgerjs-hw-app-sui';
import { LedgerSigner } from '@mysten/signers/ledger';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import 'dotenv/config';

const TransportNodeHid = TransportNodeHidModule.default ?? TransportNodeHidModule;

// ───────── env ─────────
const DERIVATION_PATH = process.env.DERIVATION_PATH;      // e.g. "44'/784'/0'/0'/0'"
const RECEIVER_ADDRESS = process.env.RECEIVER_ADDRESS;    // 0x... recipient
const OBJECT_ID = process.env.OBJECT_ID;                  // 0x... object to transfer

if (!DERIVATION_PATH) throw new Error('DERIVATION_PATH is not set in .env');
if (!RECEIVER_ADDRESS) throw new Error('RECEIVER_ADDRESS is not set in .env');
if (!OBJECT_ID) throw new Error('OBJECT_ID is not set in .env');
// ───────────────────────

const transport = await TransportNodeHid.open(undefined);
const ledgerClient = new SuiLedgerClient(transport);
const suiClient = new SuiClient({ url: getFullnodeUrl('mainnet') });

const signer = await LedgerSigner.fromDerivationPath(
    DERIVATION_PATH,
    ledgerClient,
    suiClient,
);

const SENDER_ADDRESS = signer.toSuiAddress();
console.log('Ledger address (sender):', SENDER_ADDRESS);
console.log('Object to transfer:     ', OBJECT_ID);
console.log('Recipient:              ', RECEIVER_ADDRESS);

export async function send() {
    // 1. Sanity-check the object: exists, owned by sender, address-owned (transferable)
    const obj = await suiClient.getObject({
        id: OBJECT_ID,
        options: { showOwner: true, showType: true },
    });
    if (obj.error || !obj.data) {
        throw new Error(`Object not found or error: ${JSON.stringify(obj.error)}`);
    }
    console.log('Object type:            ', obj.data.type);

    const owner = obj.data.owner;
    const ownerAddr =
        owner && typeof owner === 'object' && 'AddressOwner' in owner
            ? owner.AddressOwner
            : null;
    if (!ownerAddr) {
        throw new Error(
            `Object is not address-owned (shared/immutable/object-owned), cannot transfer. Owner: ${JSON.stringify(
                owner,
            )}`,
        );
    }
    if (ownerAddr.toLowerCase() !== SENDER_ADDRESS.toLowerCase()) {
        throw new Error(
            `Object is owned by ${ownerAddr}, but the Ledger sender is ${SENDER_ADDRESS}`,
        );
    }

    // 2. Build Transaction: transfer a single object to the recipient
    const tx = new Transaction();
    tx.setSender(SENDER_ADDRESS);
    tx.transferObjects([tx.object(OBJECT_ID)], tx.pure.address(RECEIVER_ADDRESS));

    const txBytes = await tx.build({ client: suiClient });
    console.log('tx bytes length:        ', txBytes.length);

    // 3. Sign using Ledger
    console.log(
        '\nOpen your Ledger, unlock it, open the Sui app, and approve the transaction on device...',
    );
    console.log(
        '(If the device rejects with a parse error, enable Blind Signing in the Sui app settings and retry.)',
    );
    const { signature } = await signer.signTransaction(txBytes);
    console.log('signature:              ', signature);

    // 4. Execute
    const result = await suiClient.executeTransactionBlock({
        transactionBlock: txBytes,
        signature,
        requestType: 'WaitForLocalExecution',
        options: { showEffects: true, showObjectChanges: true },
    });

    console.log(`\nTransfer Transaction → ${result.digest}`);
    console.log('Status:                 ', result.effects?.status?.status);
    if (result.effects?.status?.error) {
        throw new Error(`On-chain error: ${result.effects.status.error}`);
    }
}

try {
    await send();
} finally {
    await transport.close();
}