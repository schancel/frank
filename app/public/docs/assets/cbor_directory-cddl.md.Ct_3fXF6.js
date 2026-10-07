import{_ as s,o as a,c as e,a3 as p}from"./chunks/framework.BiZN3XWs.js";const m=JSON.parse('{"title":"Directory CDDL Schema (directory.cddl)","description":"","frontmatter":{},"headers":[],"relativePath":"cbor/directory-cddl.md","filePath":"cbor/directory-cddl.md","lastUpdated":1791334697000}'),r={name:"cbor/directory-cddl.md"};function i(l,n,t,c,o,d){return a(),e("div",null,[...n[0]||(n[0]=[p(`<h1 id="directory-cddl-schema-directory-cddl" tabindex="-1">Directory CDDL Schema (<code>directory.cddl</code>) <a class="header-anchor" href="#directory-cddl-schema-directory-cddl" aria-label="Permalink to &quot;Directory CDDL Schema (\`directory.cddl\`)&quot;">​</a></h1><p><strong>Status</strong>: Active Production Standard &amp; Preview Profile<br><strong>Schema Path</strong>: <code>docs/protocol/cbor/directory.cddl</code></p><hr><h2 id="_1-overview" tabindex="-1">1. Overview <a class="header-anchor" href="#_1-overview" aria-label="Permalink to &quot;1. Overview&quot;">​</a></h2><p><code>directory.cddl</code> specifies the schemas governing self-custodial account identity, directory statements, relay bindings, and authority key transitions:</p><ul><li>Type 2: <strong>Directory Attestation</strong> (<code>directory-attestation</code>)</li><li>Type 4: <strong>Directory Statement</strong> (<code>directory-statement</code>, <code>directory-statement-v4</code>)</li><li>Type 7: <strong>Key Transition Statement</strong> (<code>key-transition-statement</code>)</li><li>Canonical Handle Constraints (<code>canonical-username</code>)</li></ul><hr><h2 id="_2-cddl-source-definition" tabindex="-1">2. CDDL Source Definition <a class="header-anchor" href="#_2-cddl-source-definition" aria-label="Permalink to &quot;2. CDDL Source Definition&quot;">​</a></h2><div class="language-cddl vp-adaptive-theme line-numbers-mode"><button title="Copy Code" class="copy"></button><span class="lang">cddl</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>; Type 2 wraps and signs the complete Type 4 statement frame.</span></span>
<span class="line"><span>directory-attestation = {</span></span>
<span class="line"><span>  0: framed-object,         ; type-4 directory-statement frame</span></span>
<span class="line"><span>  1: [1*16 signature-entry],; signatures by directory authority P</span></span>
<span class="line"><span>  * uint =&gt; frank-value,</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>; Type 4 schema 4 / min_reader 4: Production Directory Preview</span></span>
<span class="line"><span>directory-statement-v4 = {</span></span>
<span class="line"><span>  0: network-tag,           ; e.g. &quot;monad-testnet&quot;</span></span>
<span class="line"><span>  1: directory-preview-key, ; directory authority public key P</span></span>
<span class="line"><span>  2: uint .le 18446744073709551615, ; monotonic revision (0 at genesis)</span></span>
<span class="line"><span>  3: timestamp,             ; issue time</span></span>
<span class="line"><span>  4: [directory-preview-relay], ; bound relay endpoints</span></span>
<span class="line"><span>  6: timestamp,             ; expiry (positive validity &lt;= 3600s)</span></span>
<span class="line"><span>  8: directory-preview-key, ; stamp receipt key P&#39;</span></span>
<span class="line"><span>  10: directory-preview-key,; message encryption key M</span></span>
<span class="line"><span>  11: uint .le 18446744073709551615, ; mailbox_key_generation</span></span>
<span class="line"><span>  12: uint .le 18446744073709551615, ; stamp_key_generation</span></span>
<span class="line"><span>  13: null / bstr .size 32, ; predecessor Type 4 T1 hash; null at rev 0</span></span>
<span class="line"><span>  ? 14: canonical-username, ; optional canonical username handle</span></span>
<span class="line"><span>  * uint =&gt; frank-value,</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>directory-preview-key = {</span></span>
<span class="line"><span>  0: 1,                     ; secp256k1 key type</span></span>
<span class="line"><span>  1: bstr .size 33          ; 33-byte compressed SEC1 public key point</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>directory-preview-relay = {</span></span>
<span class="line"><span>  0: bstr .size (16..64),   ; relay node identifier</span></span>
<span class="line"><span>  1: tstr .size (1..2048),  ; HTTPS URI (no trailing slash)</span></span>
<span class="line"><span>  2: directory-preview-key, ; relay public key</span></span>
<span class="line"><span>  3: timestamp,             ; relay binding expiry</span></span>
<span class="line"><span>  * uint =&gt; frank-value,</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>; Canonical username handle constraint:</span></span>
<span class="line"><span>; Matches ^[a-z0-9][a-z0-9_-]{2,31}$ (3 to 32 chars, lowercase alphanumeric, -, _)</span></span>
<span class="line"><span>canonical-username = tstr .size (3..32)</span></span></code></pre><div class="line-numbers-wrapper" aria-hidden="true"><span class="line-number">1</span><br><span class="line-number">2</span><br><span class="line-number">3</span><br><span class="line-number">4</span><br><span class="line-number">5</span><br><span class="line-number">6</span><br><span class="line-number">7</span><br><span class="line-number">8</span><br><span class="line-number">9</span><br><span class="line-number">10</span><br><span class="line-number">11</span><br><span class="line-number">12</span><br><span class="line-number">13</span><br><span class="line-number">14</span><br><span class="line-number">15</span><br><span class="line-number">16</span><br><span class="line-number">17</span><br><span class="line-number">18</span><br><span class="line-number">19</span><br><span class="line-number">20</span><br><span class="line-number">21</span><br><span class="line-number">22</span><br><span class="line-number">23</span><br><span class="line-number">24</span><br><span class="line-number">25</span><br><span class="line-number">26</span><br><span class="line-number">27</span><br><span class="line-number">28</span><br><span class="line-number">29</span><br><span class="line-number">30</span><br><span class="line-number">31</span><br><span class="line-number">32</span><br><span class="line-number">33</span><br><span class="line-number">34</span><br><span class="line-number">35</span><br><span class="line-number">36</span><br><span class="line-number">37</span><br><span class="line-number">38</span><br><span class="line-number">39</span><br><span class="line-number">40</span><br></div></div>`,9)])])}const u=s(r,[["render",i]]);export{m as __pageData,u as default};
