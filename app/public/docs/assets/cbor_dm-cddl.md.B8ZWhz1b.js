import{_ as s,o as a,c as e,a3 as p}from"./chunks/framework.BiZN3XWs.js";const d=JSON.parse('{"title":"Direct Message CDDL Schema (direct-message.cddl)","description":"","frontmatter":{},"headers":[],"relativePath":"cbor/dm-cddl.md","filePath":"cbor/dm-cddl.md","lastUpdated":1791348521000}'),l={name:"cbor/dm-cddl.md"};function i(r,n,c,t,o,b){return a(),e("div",null,[...n[0]||(n[0]=[p(`<h1 id="direct-message-cddl-schema-direct-message-cddl" tabindex="-1">Direct Message CDDL Schema (<code>direct-message.cddl</code>) <a class="header-anchor" href="#direct-message-cddl-schema-direct-message-cddl" aria-label="Permalink to &quot;Direct Message CDDL Schema (\`direct-message.cddl\`)&quot;">​</a></h1><p><strong>Status</strong>: Active Production Standard<br><strong>Schema Path</strong>: <code>docs/protocol/cbor/direct-message.cddl</code></p><hr><h2 id="_1-overview" tabindex="-1">1. Overview <a class="header-anchor" href="#_1-overview" aria-label="Permalink to &quot;1. Overview&quot;">​</a></h2><p><code>direct-message.cddl</code> defines the wire structures for:</p><ul><li>Type 1: <strong>Direct Message Delivery</strong> (<code>direct-message-delivery</code>)</li><li>Type 5: <strong>Recipient Encrypted Payload</strong> (<code>recipient-encrypted-payload-v2</code>)</li><li>Type 6: <strong>Encrypted Message Content</strong> (<code>encrypted-message-content</code>)</li><li>Type 8: <strong>Message Content Revision</strong> (<code>message-content-revision</code>)</li><li>Type 16: <strong>Container Message Item</strong> (<code>container-message-item</code>)</li><li>Type 17: <strong>Text Message Item</strong> (<code>text-message-item</code>)</li><li>Type 19: <strong>Stealth Payment Item</strong> (<code>stealth-message-item</code>)</li><li>Type 24: <strong>Universal State Channel Update</strong> (<code>channel-update-item</code>)</li><li>Type 25: <strong>Forwarding Delivery Envelope</strong> (<code>forwarding-delivery-envelope</code>)</li></ul><hr><h2 id="_2-cddl-source-definition" tabindex="-1">2. CDDL Source Definition <a class="header-anchor" href="#_2-cddl-source-definition" aria-label="Permalink to &quot;2. CDDL Source Definition&quot;">​</a></h2><div class="language-cddl vp-adaptive-theme line-numbers-mode"><button title="Copy Code" class="copy"></button><span class="lang">cddl</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>; Payload schemas for Type 1, Type 5, Type 6, Type 8, and Type 25 frames.</span></span>
<span class="line"><span></span></span>
<span class="line"><span>direct-message-delivery = {</span></span>
<span class="line"><span>  0: network-tag,</span></span>
<span class="line"><span>  1: account-ref,          ; stamp key P&#39; the sender used, key type 1</span></span>
<span class="line"><span>  2: framed-object,        ; recipient-specific encrypted-payload frame</span></span>
<span class="line"><span>  3: digest-32,            ; T3 digest of the exact field-2 frame</span></span>
<span class="line"><span>  4: [1*64 payment-member],; storage/delivery payment stamps</span></span>
<span class="line"><span>  ? 5: account-ref,        ; long-term recipient identity P (key type 1)</span></span>
<span class="line"><span>  ? 6: dleq-proof,         ; Chaum-Pedersen DLEQ proof</span></span>
<span class="line"><span>  * uint =&gt; frank-value,</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>payment-member = {</span></span>
<span class="line"><span>  0: uint .le 2147483647,  ; stamp child index i</span></span>
<span class="line"><span>  1: bstr .size (1..128),  ; chain transaction identifier</span></span>
<span class="line"><span>  2: evm-quantity-256 / uint, ; verified value in wei or satoshis</span></span>
<span class="line"><span>  3: bstr .size (1..128),  ; derived destination/address bytes</span></span>
<span class="line"><span>  4: digest-32,            ; exact T4 commitment verified in the transaction</span></span>
<span class="line"><span>  ? 5: uint .le 4294967295, ; UTXO output index (vout)</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>stamp-point = bstr .size 33 ; 33-byte compressed SEC1 secp256k1 point</span></span>
<span class="line"><span>dleq-proof = bstr .size 64  ; 64-byte Chaum-Pedersen DLEQ proof (c || s)</span></span>
<span class="line"><span></span></span>
<span class="line"><span>; Type 5 schema 2, min_reader_version 2: production DM payload</span></span>
<span class="line"><span>recipient-encrypted-payload-v2 = {</span></span>
<span class="line"><span>  0: network-tag,</span></span>
<span class="line"><span>  1: account-ref,          ; routing sender identity</span></span>
<span class="line"><span>  2: account-ref,          ; routing recipient identity</span></span>
<span class="line"><span>  3: 1,                    ; Frank-CBOR authenticated XChaCha20-Poly1305 suite</span></span>
<span class="line"><span>  4: bstr .size (1..524376), ; complete crypto-box v2 envelope</span></span>
<span class="line"><span>  5: stamp-point,          ; ephemeral point E</span></span>
<span class="line"><span>  6: stamp-point,          ; blinded stamp point X</span></span>
<span class="line"><span>  7: dleq-proof,           ; DLEQ proof</span></span>
<span class="line"><span>  * uint =&gt; frank-value,</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>encrypted-message-content = {</span></span>
<span class="line"><span>  0: network-tag,</span></span>
<span class="line"><span>  1: uuid-16,              ; stable logical message_id</span></span>
<span class="line"><span>  2: framed-object,        ; type-8 message-content-revision frame</span></span>
<span class="line"><span>  3: digest-32,            ; T1a digest of field 2</span></span>
<span class="line"><span>  4: uuid-16,              ; stable logical conversation_id</span></span>
<span class="line"><span>  ? 5: tstr .size (1..512),; optional conversation name</span></span>
<span class="line"><span>  * uint =&gt; frank-value,</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>message-content-revision = {</span></span>
<span class="line"><span>  0: &quot;frank&quot;,              ; logical transcript domain</span></span>
<span class="line"><span>  1: [1*256 framed-object],; ordered semantic message-item frames</span></span>
<span class="line"><span>  * uint =&gt; frank-value,</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>container-message-item = {</span></span>
<span class="line"><span>  0: [1*256 framed-object], ; child frames</span></span>
<span class="line"><span>  * uint =&gt; frank-value,</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>text-message-item = {</span></span>
<span class="line"><span>  0: tstr .size (0..262144), ; UTF-8 chat text (up to 256 KiB)</span></span>
<span class="line"><span>  * uint =&gt; frank-value,</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>; Type 19 schema 1: Stealth payment item</span></span>
<span class="line"><span>stealth-message-item = {</span></span>
<span class="line"><span>  0: network-tag,</span></span>
<span class="line"><span>  1: account-ref,            ; ephemeral pubkey (key type 1 or 2)</span></span>
<span class="line"><span>  2: [1*16 bstr .size (1..16384)], ; raw transaction payloads or hashes</span></span>
<span class="line"><span>  3: uint,                   ; transferred value</span></span>
<span class="line"><span>  ? 4: tstr .size (0..1024), ; optional memo</span></span>
<span class="line"><span>  * uint =&gt; frank-value,</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>; Type 24 schema 1: Universal state channel update item</span></span>
<span class="line"><span>channel-update-item = {</span></span>
<span class="line"><span>  0: digest-32,              ; unique channel-id</span></span>
<span class="line"><span>  1: tstr .size (1..64),     ; app-id (&quot;swap&quot;, &quot;dice&quot;, &quot;poker&quot;, &quot;raffle&quot;)</span></span>
<span class="line"><span>  2: uint .le 4294967295,    ; sequence-number (state turn / nonce)</span></span>
<span class="line"><span>  3: [1*8 chain-allocation], ; allocations across 1 or more networks</span></span>
<span class="line"><span>  4: bstr .size (0..65536),  ; app-state (opaque or nested CBOR payload)</span></span>
<span class="line"><span>  5: [1*4 signature-entry],  ; participant signatures over state digest</span></span>
<span class="line"><span>  ? 6: bstr .size (1..128),  ; optional on-chain settlement contract or script reference</span></span>
<span class="line"><span>  * uint =&gt; frank-value,</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>; Type 25 schema 1: Store-and-forward relay forwarding delivery envelope</span></span>
<span class="line"><span>forwarding-delivery-envelope = {</span></span>
<span class="line"><span>  0: network-tag,          ; destination relay network</span></span>
<span class="line"><span>  1: account-ref,          ; destination relay routing identity</span></span>
<span class="line"><span>  2: framed-object,        ; inner Type 1 direct-message-delivery frame</span></span>
<span class="line"><span>  3: digest-32,            ; forwarding payload digest of field 2</span></span>
<span class="line"><span>  4: [1*64 payment-member],; relay storage payment stamps</span></span>
<span class="line"><span>  ? 5: tstr .size (1..256),; optional destination relay endpoint URI</span></span>
<span class="line"><span>  ? 6: uint .le 4294967295,; optional delivery TTL timestamp</span></span>
<span class="line"><span>  * uint =&gt; frank-value,</span></span>
<span class="line"><span>}</span></span></code></pre><div class="line-numbers-wrapper" aria-hidden="true"><span class="line-number">1</span><br><span class="line-number">2</span><br><span class="line-number">3</span><br><span class="line-number">4</span><br><span class="line-number">5</span><br><span class="line-number">6</span><br><span class="line-number">7</span><br><span class="line-number">8</span><br><span class="line-number">9</span><br><span class="line-number">10</span><br><span class="line-number">11</span><br><span class="line-number">12</span><br><span class="line-number">13</span><br><span class="line-number">14</span><br><span class="line-number">15</span><br><span class="line-number">16</span><br><span class="line-number">17</span><br><span class="line-number">18</span><br><span class="line-number">19</span><br><span class="line-number">20</span><br><span class="line-number">21</span><br><span class="line-number">22</span><br><span class="line-number">23</span><br><span class="line-number">24</span><br><span class="line-number">25</span><br><span class="line-number">26</span><br><span class="line-number">27</span><br><span class="line-number">28</span><br><span class="line-number">29</span><br><span class="line-number">30</span><br><span class="line-number">31</span><br><span class="line-number">32</span><br><span class="line-number">33</span><br><span class="line-number">34</span><br><span class="line-number">35</span><br><span class="line-number">36</span><br><span class="line-number">37</span><br><span class="line-number">38</span><br><span class="line-number">39</span><br><span class="line-number">40</span><br><span class="line-number">41</span><br><span class="line-number">42</span><br><span class="line-number">43</span><br><span class="line-number">44</span><br><span class="line-number">45</span><br><span class="line-number">46</span><br><span class="line-number">47</span><br><span class="line-number">48</span><br><span class="line-number">49</span><br><span class="line-number">50</span><br><span class="line-number">51</span><br><span class="line-number">52</span><br><span class="line-number">53</span><br><span class="line-number">54</span><br><span class="line-number">55</span><br><span class="line-number">56</span><br><span class="line-number">57</span><br><span class="line-number">58</span><br><span class="line-number">59</span><br><span class="line-number">60</span><br><span class="line-number">61</span><br><span class="line-number">62</span><br><span class="line-number">63</span><br><span class="line-number">64</span><br><span class="line-number">65</span><br><span class="line-number">66</span><br><span class="line-number">67</span><br><span class="line-number">68</span><br><span class="line-number">69</span><br><span class="line-number">70</span><br><span class="line-number">71</span><br><span class="line-number">72</span><br><span class="line-number">73</span><br><span class="line-number">74</span><br><span class="line-number">75</span><br><span class="line-number">76</span><br><span class="line-number">77</span><br><span class="line-number">78</span><br><span class="line-number">79</span><br><span class="line-number">80</span><br><span class="line-number">81</span><br><span class="line-number">82</span><br><span class="line-number">83</span><br><span class="line-number">84</span><br><span class="line-number">85</span><br><span class="line-number">86</span><br><span class="line-number">87</span><br><span class="line-number">88</span><br><span class="line-number">89</span><br><span class="line-number">90</span><br><span class="line-number">91</span><br><span class="line-number">92</span><br><span class="line-number">93</span><br><span class="line-number">94</span><br><span class="line-number">95</span><br><span class="line-number">96</span><br><span class="line-number">97</span><br></div></div>`,9)])])}const u=s(l,[["render",i]]);export{d as __pageData,u as default};
