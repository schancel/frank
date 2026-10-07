import{_ as s,o as a,c as e,a3 as p}from"./chunks/framework.Zs2ruvLs.js";const d=JSON.parse('{"title":"Common CDDL Schema (common.cddl)","description":"","frontmatter":{},"headers":[],"relativePath":"cbor/common-cddl.md","filePath":"cbor/common-cddl.md","lastUpdated":1791334697000}'),l={name:"cbor/common-cddl.md"};function r(c,n,i,t,o,b){return a(),e("div",null,[...n[0]||(n[0]=[p(`<h1 id="common-cddl-schema-common-cddl" tabindex="-1">Common CDDL Schema (<code>common.cddl</code>) <a class="header-anchor" href="#common-cddl-schema-common-cddl" aria-label="Permalink to &quot;Common CDDL Schema (\`common.cddl\`)&quot;">​</a></h1><p><strong>Status</strong>: Frozen Specification Primitive<br><strong>Schema Path</strong>: <code>docs/protocol/cbor/common.cddl</code></p><hr><h2 id="_1-overview" tabindex="-1">1. Overview <a class="header-anchor" href="#_1-overview" aria-label="Permalink to &quot;1. Overview&quot;">​</a></h2><p><code>common.cddl</code> defines the fundamental scalar types, timestamps, cryptographic references, and generic container structures shared across all Frank protocol families.</p><hr><h2 id="_2-cddl-source-definition" tabindex="-1">2. CDDL Source Definition <a class="header-anchor" href="#_2-cddl-source-definition" aria-label="Permalink to &quot;2. CDDL Source Definition&quot;">​</a></h2><div class="language-cddl vp-adaptive-theme line-numbers-mode"><button title="Copy Code" class="copy"></button><span class="lang">cddl</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>; The five .cddl files are one schema: concatenate them (common.cddl first)</span></span>
<span class="line"><span>; before compiling, because CDDL has no import. The \`* uint =&gt; frank-value\`</span></span>
<span class="line"><span>; wildcards describe how a reader sees a newer compatible schema; at an</span></span>
<span class="line"><span>; exactly supported schema version an undeclared key is a \`schema\` error.</span></span>
<span class="line"><span></span></span>
<span class="line"><span>frank-envelope = {</span></span>
<span class="line"><span>  0: uint .le 4294967295, ; type_id</span></span>
<span class="line"><span>  1: 1..4294967295,       ; schema_version</span></span>
<span class="line"><span>  2: 1..4294967295,       ; min_reader_version</span></span>
<span class="line"><span>  3: bstr,                ; exactly one restricted canonical-CBOR payload item</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>network-tag = tstr .size (1..64)</span></span>
<span class="line"><span>digest-32 = bstr .size 32</span></span>
<span class="line"><span>uuid-16 = bstr .size 16</span></span>
<span class="line"><span>evm-quantity-256 = bstr .size 32</span></span>
<span class="line"><span></span></span>
<span class="line"><span>timestamp = {</span></span>
<span class="line"><span>  0: -9223372036854775808..9223372036854775807, ; seconds since UNIX epoch</span></span>
<span class="line"><span>  1: uint .le 999999999,                          ; nanoseconds fraction</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>account-ref = {</span></span>
<span class="line"><span>  0: uint .le 65535,      ; allocated key_type (1: secp256k1, 2: ed25519)</span></span>
<span class="line"><span>  1: bstr .size (1..128), ; key bytes, interpreted only by key_type</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>; The generic profile value. Protocol maps use unsigned integer keys even when</span></span>
<span class="line"><span>; their schema is not yet known; all other CBOR major/simple types are excluded.</span></span>
<span class="line"><span>frank-value =</span></span>
<span class="line"><span>  uint /</span></span>
<span class="line"><span>  nint /</span></span>
<span class="line"><span>  bstr /</span></span>
<span class="line"><span>  tstr /</span></span>
<span class="line"><span>  [* frank-value] /</span></span>
<span class="line"><span>  {* uint =&gt; frank-value} /</span></span>
<span class="line"><span>  false /</span></span>
<span class="line"><span>  true /</span></span>
<span class="line"><span>  null</span></span>
<span class="line"><span></span></span>
<span class="line"><span>framed-object = bstr .size (9..33554432)</span></span>
<span class="line"><span></span></span>
<span class="line"><span>signature-entry = {</span></span>
<span class="line"><span>  0: uint .le 65535,      ; exact signature algorithm/profile identifier</span></span>
<span class="line"><span>  1: account-ref,         ; signing public key</span></span>
<span class="line"><span>  2: bstr .size (1..512), ; signature bytes (strict-DER low-S ECDSA or Ed25519)</span></span>
<span class="line"><span>}</span></span></code></pre><div class="line-numbers-wrapper" aria-hidden="true"><span class="line-number">1</span><br><span class="line-number">2</span><br><span class="line-number">3</span><br><span class="line-number">4</span><br><span class="line-number">5</span><br><span class="line-number">6</span><br><span class="line-number">7</span><br><span class="line-number">8</span><br><span class="line-number">9</span><br><span class="line-number">10</span><br><span class="line-number">11</span><br><span class="line-number">12</span><br><span class="line-number">13</span><br><span class="line-number">14</span><br><span class="line-number">15</span><br><span class="line-number">16</span><br><span class="line-number">17</span><br><span class="line-number">18</span><br><span class="line-number">19</span><br><span class="line-number">20</span><br><span class="line-number">21</span><br><span class="line-number">22</span><br><span class="line-number">23</span><br><span class="line-number">24</span><br><span class="line-number">25</span><br><span class="line-number">26</span><br><span class="line-number">27</span><br><span class="line-number">28</span><br><span class="line-number">29</span><br><span class="line-number">30</span><br><span class="line-number">31</span><br><span class="line-number">32</span><br><span class="line-number">33</span><br><span class="line-number">34</span><br><span class="line-number">35</span><br><span class="line-number">36</span><br><span class="line-number">37</span><br><span class="line-number">38</span><br><span class="line-number">39</span><br><span class="line-number">40</span><br><span class="line-number">41</span><br><span class="line-number">42</span><br><span class="line-number">43</span><br><span class="line-number">44</span><br><span class="line-number">45</span><br><span class="line-number">46</span><br><span class="line-number">47</span><br></div></div>`,8)])])}const u=s(l,[["render",r]]);export{d as __pageData,u as default};
