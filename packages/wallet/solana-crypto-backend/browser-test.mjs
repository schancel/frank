// Real disposable-browser WASM test. Synthetic credentials; no RPC/relay/funding.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ed25519 } = require("@noble/curves/ed25519");
const {
  PublicKey,
  VersionedMessage,
  TransactionMessage,
  SystemInstruction,
  VersionedTransaction,
} = require("@solana/web3.js");
assert(
  !(
    await readFile(new URL("./generated/backend.js", import.meta.url), "utf8")
  ).includes("signTransfer("),
  "obsolete signer must not exist in generated WASM binding"
);
const fixture = JSON.parse(
  await readFile(
    new URL("../solana-stealth-vectors/vectors.json", import.meta.url)
  )
);
const token = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
).toBytes();
const mint = new PublicKey(
  "BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k"
).toBytes();
const python = `import sys,json;sys.path.insert(0,sys.argv[1]);import generate as g;print(json.dumps(g.vector('configured-devUSDC',bytes(range(32)),2,[1,bytes.fromhex(sys.argv[2]),bytes.fromhex(sys.argv[3])],1,9007199254740993)))`;
const spl = JSON.parse(
  execFileSync(
    "python3",
    [
      "-c",
      python,
      new URL("../solana-stealth-vectors/", import.meta.url).pathname,
      Buffer.from(mint).toString("hex"),
      Buffer.from(token).toString("hex"),
    ],
    { encoding: "utf8" }
  )
);
const vectors = [...fixture.vectors.filter((v) => v.asset[0] === 0), spl];
const raw = (hex) => Array.from(Buffer.from(hex, "hex"));
const cases = vectors.map((v) => {
  const asset =
    v.asset[0] === 0
      ? { kind: "native" }
      : { kind: "spl", mint: raw(v.asset[1]), tokenProgram: raw(v.asset[2]) };
  const descriptor = {
    chainIdentifier: v.chainIdentifier,
    asset,
    recipient: raw(v.B),
    ephemeral: raw(v.R),
    operationId: raw(v.operationId),
    memberIndex: v.memberIndex,
    messageContext: raw(v.messageContext),
    recipientAmount: v.amount,
  };
  const spend = {
    chainIdentifier: v.chainIdentifier,
    asset,
    owner: raw(v.P),
    destination: Array.from({ length: 32 }, (_, i) => 96 + i),
    amount: v.amount,
    recentBlockhash: Array(32).fill(85),
    operationId: Array(32).fill(86),
    messageContext: Array(32).fill(87),
    decimals: asset.kind === "native" ? null : 6,
  };
  return { seed: raw(v.seed), descriptor, spend };
});
const senderVectors = JSON.parse(
  await readFile(new URL("./sender-vectors.json", import.meta.url))
);
const page = `<!doctype html><script type="module">
import {openExperimentalRecipientCustody} from '/runtime.mjs';
window.result=(async()=>{
 const cases=await(await fetch('/cases')).json();let rejected=0;
 const badSeed=new Uint8Array(32).fill(99);try{await openExperimentalRecipientCustody({accountId:new Uint8Array(32),chainIdentifier:'solana',seed:badSeed,wasm:new URL('/generated/backend_bg.wasm',location.href)});throw Error('alias accepted')}catch(e){if(!String(e).includes('InvalidChain'))throw e;rejected++}
 if(badSeed.some(x=>x!==0))throw Error('failed open retained host seed');
 const controller=new AbortController();const c=cases[0];const aborted=await openExperimentalRecipientCustody({accountId:new Uint8Array(32).fill(7),chainIdentifier:c.descriptor.chainIdentifier,seed:Uint8Array.from(c.seed),signal:controller.signal,wasm:new URL('/generated/backend_bg.wasm',location.href)});
 controller.abort();try{aborted.primaryPublicKey();throw Error('aborted scope signed')}catch(e){if(!String(e).includes('Revoked'))throw e;rejected++}
 const alreadyAbortedSeed=Uint8Array.from(c.seed);try{await openExperimentalRecipientCustody({accountId:new Uint8Array(32),chainIdentifier:c.descriptor.chainIdentifier,seed:alreadyAbortedSeed,signal:controller.signal,wasm:new URL('/generated/backend_bg.wasm',location.href)});throw Error('aborted open accepted')}catch(e){if(!String(e).includes('Revoked'))throw e;rejected++}
 if(alreadyAbortedSeed.some(x=>x!==0))throw Error('aborted open retained seed');
 const senderCases=await(await fetch('/sender-cases')).json();const senderOutputs=[];const ataOutputs=[];
 for(const c of senderCases){
  const intent=structuredClone(c.intent);intent.asset=intent.asset[0]===0?{kind:'native'}:{kind:'spl',mint:intent.asset[1],tokenProgram:intent.asset[2]};
  const options={accountId:new Uint8Array(32).fill(7),chainIdentifier:intent.chainIdentifier,wasm:new URL('/generated/backend_bg.wasm',location.href)};
  const handle=await openExperimentalRecipientCustody({...options,seed:new Uint8Array(32).fill(99)});
  const derived=handle.deriveDestination(intent);const owner=Array.from(handle.primaryPublicKey());
  const spend={chainIdentifier:intent.chainIdentifier,asset:intent.asset,owner,destination:derived.publicKey,amount:intent.recipientAmount,recentBlockhash:Array(32).fill(85),operationId:intent.operationId,messageContext:intent.messageContext,decimals:intent.asset.kind==='spl'?6:null};
  const auth={feeLamports:'0',maxFeeLamports:'0',rentLamports:'0',maxRentLamports:'0',maxNativeDebitLamports:intent.asset.kind==='native'?intent.recipientAmount:'0',createDestinationAta:false};
  const output=handle.signPrimaryTransfer(derived.descriptor,spend,auth);
  for(const mutate of [s=>s.destination[0]^=1,s=>s.amount='2',s=>s.operationId[0]^=1,s=>s.messageContext[0]^=1,s=>s.owner[0]^=1]){
   const bad=structuredClone(spend);mutate(bad);try{handle.signPrimaryTransfer(derived.descriptor,bad,auth);throw Error('primary mutation accepted')}catch(e){if(!String(e).includes('solana-custody:'))throw e;rejected++}
  }
  for(const mutate of [a=>a.feeLamports='1',a=>a.rentLamports='1',a=>a.createDestinationAta=true,a=>a.maxFeeLamports='1',a=>a.hidden=1]){
   const bad=structuredClone(auth);mutate(bad);try{handle.signPrimaryTransfer(derived.descriptor,spend,bad);throw Error('authorization mutation accepted')}catch(e){if(!String(e).includes('solana-custody:'))throw e;rejected++}
  }
  const bad=structuredClone(derived.descriptor);bad.ephemeral[0]^=1;
  try{handle.signPrimaryTransfer(bad,spend,auth);throw Error('wrong R accepted')}catch(e){if(!String(e).includes('InvalidDestination'))throw e;rejected++}
  if(intent.asset.kind==='spl'){
   // Synthetic immutable read-only RPC quote facts, not a live network query.
   const quote=Object.freeze({feeLamports:'5000',classicAccountBytes:165,rentLamports:'2039280'});
   const ataAuth={feeLamports:quote.feeLamports,maxFeeLamports:'6000',rentLamports:quote.rentLamports,maxRentLamports:'2040000',maxNativeDebitLamports:'2046000',createDestinationAta:true};
   const signed=handle.signPrimaryTransfer(derived.descriptor,spend,ataAuth);
   for(const mutate of [a=>a.maxNativeDebitLamports='2044280',a=>a.rentLamports='2040001',a=>a.rentLamports='0',a=>a.createDestinationAta=false]){const bad=structuredClone(ataAuth);mutate(bad);try{handle.signPrimaryTransfer(derived.descriptor,spend,bad);throw Error('ATA cap accepted')}catch(e){if(!String(e).includes('InvalidAmount'))throw e;rejected++}}
   ataOutputs.push({derived,quote,publicKey:Array.from(signed.publicKey),message:Array.from(signed.message),signature:Array.from(signed.signature)});
  }
  handle.close();const again=await openExperimentalRecipientCustody({...options,seed:new Uint8Array(32).fill(99)});
  if(JSON.stringify(derived)!==JSON.stringify(again.deriveDestination(intent)))throw Error('sender reopen changed quote');again.close();
  senderOutputs.push({derived,publicKey:Array.from(output.publicKey),message:Array.from(output.message),signature:Array.from(output.signature)});
 }
 const receivedOutputs=[];
 for(let i=0;i<cases.length;i++){
  const c=cases[i],options={accountId:new Uint8Array(32).fill(7),chainIdentifier:c.descriptor.chainIdentifier,wasm:new URL('/generated/backend_bg.wasm',location.href)};
  const handoff=Uint8Array.from(c.seed);const imported=await openExperimentalRecipientCustody({...options,seed:handoff});if(handoff.some(x=>x!==0))throw Error('received import retained seed');if('signTransfer' in imported)throw Error('obsolete signer exported');
  const source={descriptor:c.descriptor,publicKey:c.spend.owner};
  if(Array.from(imported.validateReceivedDescriptor(source)).join(',')!==source.publicKey.join(','))throw Error('import affinity mismatch');
  localStorage.setItem('received-source-'+i,JSON.stringify(source));imported.close();
  try{imported.validateReceivedDescriptor(source);throw Error('closed source accepted')}catch(e){if(!String(e).includes('Revoked'))throw e;rejected++}
  const handle=await openExperimentalRecipientCustody({...options,seed:Uint8Array.from(c.seed)});
  const restored=JSON.parse(localStorage.getItem('received-source-'+i));
  const asset=c.descriptor.asset.kind==='native'?cases[cases.length-1].descriptor.asset:{kind:'native'};
  const intent={...c.descriptor,asset,recipientAmount:'42',operationId:Array(32).fill(90+i),messageContext:Array(32).fill(91)};delete intent.ephemeral;
  const derived=handle.deriveDestination(intent);
  const spend={chainIdentifier:intent.chainIdentifier,asset,owner:restored.publicKey,destination:derived.publicKey,amount:'42',recentBlockhash:Array(32).fill(85),operationId:intent.operationId,messageContext:intent.messageContext,decimals:asset.kind==='spl'?6:null};
  const auth={feeLamports:'5000',maxFeeLamports:'6000',rentLamports:asset.kind==='spl'?'2039280':'0',maxRentLamports:asset.kind==='spl'?'2040000':'0',maxNativeDebitLamports:asset.kind==='spl'?'2046000':'6042',createDestinationAta:asset.kind==='spl'};
  const signed=handle.signReceivedTransfer(restored,derived.descriptor,spend,auth);
  for(const mutate of [r=>r.publicKey[0]^=1,r=>r.descriptor.messageContext[0]^=1,r=>r.descriptor.recipientAmount='43',r=>r.descriptor.ephemeral[0]^=1,r=>r.descriptor.chainIdentifier='solana-mainnet']){const bad=structuredClone(restored);mutate(bad);try{handle.validateReceivedDescriptor(bad);throw Error('forged source imported')}catch(e){if(!String(e).includes('solana-custody:'))throw e;rejected++}try{handle.signReceivedTransfer(bad,derived.descriptor,spend,auth);throw Error('forged source signed')}catch(e){if(!String(e).includes('solana-custody:'))throw e;rejected++}}
  for(const mutate of [s=>s.destination[0]^=1,s=>s.owner[0]^=1,s=>s.operationId[0]^=1,s=>s.amount='43']){const bad=structuredClone(spend);mutate(bad);try{handle.signReceivedTransfer(restored,derived.descriptor,bad,auth);throw Error('received redirect accepted')}catch(e){if(!String(e).includes('solana-custody:'))throw e;rejected++}}
  const badAuth={...auth,maxNativeDebitLamports:'0'};try{handle.signReceivedTransfer(restored,derived.descriptor,spend,badAuth);throw Error('received cap accepted')}catch(e){if(!String(e).includes('InvalidAmount'))throw e;rejected++}
  handle.close();try{handle.signReceivedTransfer(restored,derived.descriptor,spend,auth);throw Error('closed received signer accepted')}catch(e){if(!String(e).includes('Revoked'))throw e;rejected++}
  receivedOutputs.push({derived,spend,publicKey:Array.from(signed.publicKey),message:Array.from(signed.message),signature:Array.from(signed.signature)});
 }
 return {rejected,senderOutputs,ataOutputs,receivedOutputs};})();
</script>`;
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'"
      );
      res.end(page);
      return;
    }
    if (req.url === "/sender-cases") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(senderVectors));
      return;
    }
    if (req.url === "/cases") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(cases));
      return;
    }
    const allowed = new Set([
      "/runtime.mjs",
      "/generated/backend.js",
      "/generated/backend_bg.wasm",
    ]);
    if (!allowed.has(req.url)) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader(
      "content-type",
      req.url.endsWith(".wasm") ? "application/wasm" : "text/javascript"
    );
    res.end(await readFile(new URL(`.${req.url}`, import.meta.url)));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "frank-solana-wasm-browser-"));
const child = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = "";
    const timeout = setTimeout(
      () => reject(Error("Chrome startup timeout")),
      20000
    );
    child.once("error", reject);
    child.stderr.on("data", (data) => {
      log += data;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const pending = new Map();
  let sequence = 0;
  socket.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (!m.id) return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const { targetId } = await call("Target.createTarget", { url: origin });
  const { sessionId } = await call("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await call("Runtime.enable", {}, sessionId);
  const evaluation = await call(
    "Runtime.evaluate",
    {
      expression:
        'new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(window.result){clearInterval(timer);window.result.then(resolve,reject)}else if(Date.now()-start>15000){clearInterval(timer);reject(Error("page timeout"))}},20)})',
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId
  );
  assert(
    !evaluation.exceptionDetails,
    JSON.stringify(evaluation.exceptionDetails)
  );
  const result = evaluation.result.value;
  for (let i = 0; i < senderVectors.length; i++) {
    const v = senderVectors[i],
      out = result.senderOutputs[i];
    assert.equal(
      Buffer.from(out.derived.descriptor.ephemeral).toString("hex"),
      v.R
    );
    assert.equal(Buffer.from(out.derived.publicKey).toString("hex"), v.P);
    const key = Buffer.from(out.publicKey),
      message = Buffer.from(out.message),
      signature = Buffer.from(out.signature);
    assert.deepEqual(
      key,
      Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(99)))
    );
    assert(ed25519.verify(signature, message, key, { zip215: false }));
    assert.deepEqual(
      signature,
      Buffer.from(ed25519.sign(message, new Uint8Array(32).fill(99)))
    );
    const spki = createPublicKey({
      format: "der",
      type: "spki",
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]),
    });
    assert(verify(null, message, spki, signature));
    const decoded = TransactionMessage.decompile(
      VersionedMessage.deserialize(message)
    );
    assert.equal(decoded.instructions.length, 2);
    if (v.intent.asset[0] === 0) {
      const ix = SystemInstruction.decodeTransfer(decoded.instructions[0]);
      assert.equal(BigInt(ix.lamports), BigInt(v.intent.recipientAmount));
      assert.equal(Buffer.from(ix.toPubkey.toBytes()).toString("hex"), v.P);
    } else {
      const ix = decoded.instructions[0];
      assert.equal(ix.data[0], 12);
      assert.equal(
        Buffer.from(ix.data).readBigUInt64LE(1),
        BigInt(v.intent.recipientAmount)
      );
      const [dest] = await PublicKey.findProgramAddress(
        [
          Buffer.from(v.P, "hex"),
          Buffer.from(v.intent.asset[2]),
          Buffer.from(v.intent.asset[1]),
        ],
        new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
      );
      assert(ix.keys[2].pubkey.equals(dest));
    }
  }
  assert.equal(result.receivedOutputs.length, vectors.length);
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i],
      out = result.receivedOutputs[i];
    const key = Buffer.from(out.publicKey),
      message = Buffer.from(out.message),
      signature = Buffer.from(out.signature);
    assert.equal(key.toString("hex"), v.P);
    assert(ed25519.verify(signature, message, key, { zip215: false }));
    const spki = createPublicKey({
      format: "der",
      type: "spki",
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]),
    });
    assert(verify(null, message, spki, signature));
    const reference =
      "import sys;sys.path.insert(0,sys.argv[1]);import generate as g;p=int.from_bytes(bytes.fromhex(sys.argv[2]),'little');z=bytes.fromhex(sys.argv[3]);m=bytes.fromhex(sys.argv[4]);k=g.hs(z+m);u=g.encoded(g.multiply(g.BASE,k));c=g.hs(u+bytes.fromhex(sys.argv[5])+m);print((u+g.le((k+c*p)%g.ORDER)).hex())";
    assert.equal(
      execFileSync(
        "python3",
        [
          "-c",
          reference,
          new URL("../solana-stealth-vectors/", import.meta.url).pathname,
          v.p,
          v.zP,
          message.toString("hex"),
          v.P,
        ],
        { encoding: "utf8" }
      ).trim(),
      signature.toString("hex")
    );
    const decoded = TransactionMessage.decompile(
      VersionedMessage.deserialize(message)
    );
    assert.equal(decoded.payerKey.toBase58(), new PublicKey(key).toBase58());
    if (out.spend.asset.kind === "native") {
      assert.equal(v.asset[0], 1);
      assert.equal(decoded.instructions.length, 2);
      const transfer = SystemInstruction.decodeTransfer(
        decoded.instructions[0]
      );
      assert.equal(BigInt(transfer.lamports), 42n);
      assert.deepEqual(
        Array.from(transfer.toPubkey.toBytes()),
        out.derived.publicKey
      );
    } else {
      assert.equal(v.asset[0], 0);
      assert.equal(decoded.instructions.length, 3);
      const transfer = decoded.instructions[1];
      assert.equal(transfer.data[0], 12);
      assert.equal(Buffer.from(transfer.data).readBigUInt64LE(1), 42n);
      const [source] = await PublicKey.findProgramAddress(
        [
          key,
          Uint8Array.from(out.spend.asset.tokenProgram),
          Uint8Array.from(out.spend.asset.mint),
        ],
        new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
      );
      assert(transfer.keys[0].pubkey.equals(source));
      assert(transfer.keys[3].pubkey.equals(new PublicKey(key)));
    }
  }
  console.log(
    "PASS restored received-source WASM: " +
      result.receivedOutputs.length +
      " validated public imports, close/reopen, cross-asset respend; exact independent Python signatures and Noble/OpenSSL/web3 verification"
  );
  assert.equal(result.ataOutputs.length, 2);
  for (const out of result.ataOutputs) {
    const key = Buffer.from(out.publicKey),
      message = Buffer.from(out.message),
      signature = Buffer.from(out.signature);
    assert.deepEqual(
      signature,
      Buffer.from(ed25519.sign(message, new Uint8Array(32).fill(99)))
    );
    const parsed = VersionedMessage.deserialize(message),
      decoded = TransactionMessage.decompile(parsed);
    assert.equal(decoded.instructions.length, 3);
    const [create, transfer, memo] = decoded.instructions;
    const ataProgram = new PublicKey(
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    );
    assert(create.programId.equals(ataProgram));
    assert.deepEqual(Array.from(create.data), [1]);
    assert.equal(create.keys.length, 6);
    const asset = out.derived.descriptor.asset,
      owner = new PublicKey(out.derived.publicKey);
    const [destAta] = await PublicKey.findProgramAddress(
      [
        owner.toBytes(),
        Uint8Array.from(asset.tokenProgram),
        Uint8Array.from(asset.mint),
      ],
      ataProgram
    );
    const expected = [
      new PublicKey(key),
      destAta,
      owner,
      new PublicKey(asset.mint),
      new PublicKey(new Uint8Array(32)),
      new PublicKey(asset.tokenProgram),
    ];
    for (let j = 0; j < 6; j++) {
      assert(create.keys[j].pubkey.equals(expected[j]));
      assert.equal(create.keys[j].isSigner, j === 0);
      assert.equal(create.keys[j].isWritable, j < 2);
    }
    assert.equal(transfer.data[0], 12);
    assert(transfer.keys[2].pubkey.equals(destAta));
    assert.equal(parsed.header.numRequiredSignatures, 1);
    assert.equal(out.quote.classicAccountBytes, 165);
    assert.equal(BigInt(out.quote.rentLamports), 2039280n);
    assert(
      Buffer.from(memo.data)
        .toString()
        .startsWith("frank:solana-custody-primary:experimental-v1:")
    );
    const tx = new VersionedTransaction(parsed);
    tx.addSignature(new PublicKey(key), signature);
    assert.deepEqual(Buffer.from(tx.message.serialize()), message);
  }
  console.log(
    "PASS explicit ATA creation WASM: fixed classic program/accounts/instruction, exact transfer and separately approved fee/rent ceilings; no extra native transfer"
  );
  console.log(
    "PASS sender WASM: " +
      result.senderOutputs.length +
      " deterministic independent destinations/primary signatures, reopen, exact transfer amounts and rejected altered quotes/caps"
  );
  console.log(
    `PASS real Chrome/WASM: ${vectors.length} native/configured-SPL synthetic transfers; Python exact signatures + Noble/OpenSSL verification; Solana/ATA parser agreement; ${result.rejected} rejected requests; seed wipe, close/reopen and operation/context binding. Profile ${profile}`
  );
} finally {
  socket?.close();
  child.kill("SIGTERM");
  server.close();
}
