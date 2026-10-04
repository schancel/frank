//! Independent T public-encoder bytes. These are offline signed bytes, not Directory or receipt authority.
use super::*;

// Captured from T8a4a46c public freezeCanonicalRequest, offline key1/chain10143/value1.
const T_BODY_HEX: &str = "2d2d6672616e6b2d666978747572652d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d2264656c6976657279220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f766e642e6672616e6b2e63626f720d0a0d0a46524e4b0100000890a400010101020103590885a5006d6d6f6e61642d746573746e657401a20001015821031932bd4a3b404c1477cab87652d75ce112d24e8b1698d8cf5b1834cfc8d33fbb025907a246524e4b0100000799a40005010202020359078ea8006d6d6f6e61642d746573746e657401a20001015821032de89548d6742189952342246af8e438ce63c8ad25a857690e353f3331d6c53702a20001015821036253871fdcfbb0497776db33754caaafad98c1b4b0ae4945ddf8660e27687a1a03010459069da6000201010219ff0003582043bed8daec2f39d9f1af1f292b277a5270772b80e8fb9eef3a99b48689039b6904582102efe3593d7c4ed3419a7055df81219a5d88eea56da4931dd5c2131f22f98c2fee05590649ad4f6a4781a00434ce5a2c2f9b7548a27a614c0f2ee0c482e118a60d1e28971a7fbe3a25c4b7733861ebc9771e4e0950fae81c8af7825b5d8b803440549af6235567b090f7f59dbfd9b6896bca74ab25933f6f32e65b12f5d56facd7f2e591818ebfbd2476c02102b9dfc69b9382a34aca902cabec67dcae8c972db19a00d375c608b8331281d6fea27d75ffd92ff541b5c15878f029034e65501821c82d138618e54857c6b0ce2c14307007a97c561c88a3f7f86b82a778b3b76a9be4a87cd18b1a83eda8d1561aa042f5858f32de17201c32e419c7f8a9c0d5c1dd4979a1817718d03876d5e5fb14e5bba867e9b49cb762d3874a90829786d6e9224c964ba0e52bbc6d241a54825a6120be0a968d2e07d4a5470455b9bd6762055c1f6e016da64e7f834b41b0116151299533a0884aa2f115ce057ea5c408ecd397bdd0219c6718565be9c549d41fd3f94b594947ca0cb43317f9457936bfa1143f9825de08eb63fbdd061c8cd9b458989f838de4af3c724aae1fb9024091b24d3fa17b34f3de321faeab4ae102347d169a0349eeaae665487f51c956adba2a4d8cc2f971651cfa8138a094cedf486d427821282205582781ca1e5d2aaf0bfbee87be13077ea59e0790d89d457889a3f2412acd8bfb3c55f373e4b7745309378f82f9bcb45d8660419f0af46fc4cff76463556787579b24a3b1d9c9605390e5d0f22fd5a95b9022721f86dbd4a7de002218469ae810ae5f1553f4d314f508e50fdbc4e863a7245bca454e75a80c5660101b30348f397de2721cd0ff9886f32d3280d2a79cac461e65692068d3fe6b7f3515764b00e2634a5f58b4064ac5b1246fe51b4f44cf5f157972bae3e7f420506e2bad634ad1d9e55997d469ca26043abe25bfbe950fedb9b42111ddc9b27cf4760d624b7935f653dae159977cb3939226ab29ac8ba8153f1ab6fc940695843d8cc7f80a1495f6f3db8708f4ea5030429936e9affd7415aa6f521a303e863e0e80247efae6e9053388439af8b5f8f205a1876e94b58581e872886211f4021034d75651cc23494fcec95d7b71f4fd5817643a65f14518c939490e113c35285ee1057cd9d5c59b4c8f000a9571b3f2a8bbb192eb0b888cdd7ef8d01fd267dfcd1be487b87535fe7096a8a91cd5e3e8851cfa94a74c322c51d86587e566a4dcf7f43477b4f4fb60d820832830b1c41710c6cfa2bf92aec394185aa80875832f7e8d8847b52518a9998d7f00ca73de2645d4d0d306ad04da2e6790645637b0314e8d7e6f752654b312458c265bb60bdc43e0b9f964df3edf164f85ac6e09a4326645fdee05eac0151ff1ea8c8cfcca5792c3431b5c386d3b41facd34edc90d7c6d5e5d9ce8541021811c620cbb08523bea8d367f36dd4c0614800de5577a2b2278fd473405b8d5e05c38b431a0d6b7c19251c4f4668908dd43900796f7acc4a299b655133100b859193e937d03db3deaa5c0a9efcaf2373a224e890c714ce04d40454d25cec2a24a30c58ee79bdf11ea590d0082b0071cbe66055f3850823183f54bd3cdb7fc319923963a8a9a396985b3c7cd1dd81aef94832aa795ea6a0bad6f60b89d0e2dae21d221d4ca2811dacb28569b2755e2a870c6649581b1eee2ef7389cb207c331a2b7e61d6b9dcd9a8cb4cb9301d8a9902e11df90b63d9137afbb2dfbd4c17958c5dcc79d519fe2a5a99c2391115e41c42642c8669e228f42d1b84749e13d370d5273a5079bbabc6c62cbca3973d1ae2bb1d2786f2de544fb62253033d203c46f2ac90e9f9b1f7bb2d6be01e2b2d53d177a1ebfd6382ae0819a4609922eb6f743450a1db5d98453b132441a73a3e4729d150a2136e938660a8558f72ceaf7bb55836d0ebc8012e90d132550ab99a27f5cbaae8efe5794c1105e9d3cd7ba0d1df5a04f774f0a02b54e2e815203ef154b6df9143c9b86eddd21b32f6ebee88008c1bd9493b8a141cdb3e09e4f801aef36c93432a4c11415b7dc67ac684b4fa46160af80a72a83950d77c1e37a6711c53e78e879775cf2ca6013337978d026fdea24f1881fc7e2eac8e1e4249bcc068e64610aa706fee619372f781d8903f2cb5f413941b9ecba4b05c2d7ac78fc8d04a10f5133c60e4499a7834e8bda518b64f1b6c1d2c6eada6ae5e08da0feed9419f701eaba13c5bbb95374f663ebf9c5d8dcbf42b734bb0776d8580b6fcf420d01c51061a3bc81cf5e8e364bb842cd94e60e5735a13aa49ab9b3149f9d422129dca13a546e4254a4923e92b5ff905582103ff218b7b9816efd78fda57849ebb9c81948df3b625011ff0ab7d6621fdcbcb03065821021ed2dceddc83589ac5335ceeb3b8b114329e49bbad5220986440be03e341341c075840b54790a36571925da0b9afcff467327e49c9cf856afcbb04b567b6e6d5673a859c5001e8a50bc7610c533dc5e87637af173f0aca86dd9e1d58f206f92b6cd1920358209f688f51d6a798d62f4b14a8b1958b14d22916ca0cb8108b91b017f238f7f2d20481a50000015820813129d69040c1f275a87a80d85d214d02f3b94649a584999ef662c3d39199f4025820000000000000000000000000000000000000000000000000000000000000000103542adf2cb0d2a8f42fd83e2c32912654a8ac76a4550458209d15a0c9d45c50955cc400ff9e8f42bf59caa0514058abad8fe9a678afb0f0570d0a2d2d6672616e6b2d666978747572652d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d22636f6e74657874220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f63626f720d0a0d0ab000781a6672616e6b2f646d2d63727970746f2d636f6e746578742f7631016d6d6f6e61642d746573746e657402a20001015821032de89548d6742189952342246af8e438ce63c8ad25a857690e353f3331d6c53703a20001015821036253871fdcfbb0497776db33754caaafad98c1b4b0ae4945ddf8660e27687a1a045820ed8493488028b1eed0bbd56edf022a19c6d13ee3e586792115012f14c82d97bb0558209b5957605976ee5d06728184df1d4174abacc4980fa145545ea07dc53e9640e506a2000101582102c05066c3239fc712592940a09c9272ea9b0373bbf548008e17a20c3d2a0161c207a2000101582103e84266f9de81abb5455f18083f781b09367263e3992bf51a9ea571f28619b81b08a20001015821031932bd4a3b404c1477cab87652d75ce112d24e8b1698d8cf5b1834cfc8d33fbb09582103ff218b7b9816efd78fda57849ebb9c81948df3b625011ff0ab7d6621fdcbcb030a5821021ed2dceddc83589ac5335ceeb3b8b114329e49bbad5220986440be03e341341c0b5840b54790a36571925da0b9afcff467327e49c9cf856afcbb04b567b6e6d5673a859c5001e8a50bc7610c533dc5e87637af173f0aca86dd9e1d58f206f92b6cd1920c010d050e020f020d0a2d2d6672616e6b2d666978747572652d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d227472616e73616374696f6e73220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f63626f720d0a0d0a81588c02f88982279f80010282c350942adf2cb0d2a8f42fd83e2c32912654a8ac76a45501a5504f4e44019d15a0c9d45c50955cc400ff9e8f42bf59caa0514058abad8fe9a678afb0f057c001a02d18d2d071778208389595d3110fe779a78cef3d25b7ebdd163df663167466f0a01e371c5d156bb5e4009df9006e84035e8e83c1200196da0cd3441a85e6d0a4680d0a2d2d6672616e6b2d666978747572652d3737372d2d0d0a";
const T_CONTENT_TYPE: &str = "multipart/form-data; boundary=frank-fixture-777";
fn fixture() -> ExactRequest {
    ExactRequest::parse(hex::decode(T_BODY_HEX).unwrap(), T_CONTENT_TYPE.into()).unwrap()
}

#[test]
fn independent_transport_original_body_and_ordinary_identity_are_exact() {
    let request = fixture();
    assert_eq!(
        hex::encode(request.submission_identity()),
        "13b3e2b495d6b1a50fd5a8584d33f50fb96595da3a963e3a676f8b5d46031367"
    );
    assert_eq!(request.body(), hex::decode(T_BODY_HEX).unwrap());
    assert_eq!(request.content_type(), T_CONTENT_TYPE);
    assert_eq!(request.transaction_count(), 1);
    assert_eq!(hex::encode(request.raw_transactions().next().unwrap()), "02f88982279f80010282c350942adf2cb0d2a8f42fd83e2c32912654a8ac76a45501a5504f4e44019d15a0c9d45c50955cc400ff9e8f42bf59caa0514058abad8fe9a678afb0f057c001a02d18d2d071778208389595d3110fe779a78cef3d25b7ebdd163df663167466f0a01e371c5d156bb5e4009df9006e84035e8e83c1200196da0cd3441a85e6d0a468");
    assert!(request.exact_equal(&fixture()));
    // A new multipart boundary preserves tuple index but changes immutable submission bytes.
    let old = "frank-fixture-777";
    let original = request.body();
    let mut rewritten = Vec::new();
    let mut position = 0;
    while let Some(relative) = find(&original[position..], old.as_bytes()) {
        rewritten.extend_from_slice(&original[position..position + relative]);
        rewritten.extend_from_slice(b"other-fixture-777");
        position += relative + old.len();
    }
    rewritten.extend_from_slice(&original[position..]);
    let alternative = ExactRequest::parse(
        rewritten,
        "multipart/form-data; boundary=other-fixture-777".into(),
    )
    .unwrap();
    assert_eq!(
        request.submission_identity(),
        alternative.submission_identity()
    );
    assert!(!request.exact_equal(&alternative));
}

#[test]
fn immutable_multipart_rejects_ambiguous_headers_framing_and_trailing_bytes() {
    let original = hex::decode(T_BODY_HEX).unwrap();
    for suffix in [b"x".as_slice(), b"\r\n".as_slice()] {
        let mut body = original.clone();
        body.extend_from_slice(suffix);
        assert!(ExactRequest::parse(body, T_CONTENT_TYPE.into()).is_err());
    }
    for content_type in [
        "multipart/form-data; boundary=\"frank-fixture-777\"",
        "multipart/form-data; boundary=frank-fixture-777; charset=utf-8",
        "multipart/form-data; boundary=",
        "multipart/mixed; boundary=frank-fixture-777",
    ] {
        assert!(ExactRequest::parse(original.clone(), content_type.into()).is_err());
    }
    for replacement in [
        "Content-Disposition: form-data; name=\"delivery\"; filename=\"x\"",
        "Content-Disposition: form-data; name=\"context\"",
        "Content-Disposition: form-data; name=\"delivery\"\r\nContent-Transfer-Encoding: binary",
    ] {
        let header = b"Content-Disposition: form-data; name=\"delivery\"";
        let at = find(&original, header).unwrap();
        let mut body = original[..at].to_vec();
        body.extend_from_slice(replacement.as_bytes());
        body.extend_from_slice(&original[at + header.len()..]);
        assert!(ExactRequest::parse(body, T_CONTENT_TYPE.into()).is_err());
    }
}

#[test]
fn raw_member_ranges_are_bounded_minimal_and_complete_before_ownership() {
    for bytes in [
        vec![0x80],
        vec![0x98, 1, 0x41, 1],
        vec![0x81, 0x58, 1, 1],
        vec![0x81, 0x40],
        vec![0x81, 0x41, 1, 0],
        vec![0x9f, 0x41, 1, 0xff],
        vec![0x98, 65],
    ] {
        assert!(transaction_ranges(&bytes, 0).is_err(), "{:x?}", bytes);
    }
    let raw = vec![7; MAX_RAW_TRANSACTION_BYTES];
    let encoded = encode_canonical(&CborValue::Array(vec![CborValue::Bytes(raw)])).unwrap();
    let ranges = transaction_ranges(&encoded, 0).unwrap();
    assert_eq!(ranges.len(), 1);
    assert_eq!(ranges[0].len(), MAX_RAW_TRANSACTION_BYTES);
    let encoded = encode_canonical(&CborValue::Array(vec![CborValue::Bytes(vec![
        7;
        MAX_RAW_TRANSACTION_BYTES
            + 1
    ])]))
    .unwrap();
    assert!(transaction_ranges(&encoded, 0).is_err());
    assert!(ExactRequest::parse(vec![0; MAX_REQUEST_BYTES + 1], T_CONTENT_TYPE.into()).is_err());
}

// Separate economic fixture: public T e4b4 transport source SHA256 41d2ec1f3148a633b7267c79828429b50a6a8e3d344d440815656ac14bd3a318.
// Ethers test-key1 re-signs existing raw using production POND02; public type1 writer + freeze API.
// Same admitted payload/context/T1s. This is a strict HTTP chain fixture, not funded-chain finality.
const GENUINE_T_BODY_HEX: &str = "2d2d6672616e6b2d67656e75696e652d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d2264656c6976657279220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f766e642e6672616e6b2e63626f720d0a0d0a46524e4b0100000890a400010101020103590885a5006d6d6f6e61642d746573746e657401a20001015821031932bd4a3b404c1477cab87652d75ce112d24e8b1698d8cf5b1834cfc8d33fbb025907a246524e4b0100000799a40005010202020359078ea8006d6d6f6e61642d746573746e657401a20001015821032de89548d6742189952342246af8e438ce63c8ad25a857690e353f3331d6c53702a20001015821036253871fdcfbb0497776db33754caaafad98c1b4b0ae4945ddf8660e27687a1a03010459069da6000201010219ff0003582043bed8daec2f39d9f1af1f292b277a5270772b80e8fb9eef3a99b48689039b6904582102efe3593d7c4ed3419a7055df81219a5d88eea56da4931dd5c2131f22f98c2fee05590649ad4f6a4781a00434ce5a2c2f9b7548a27a614c0f2ee0c482e118a60d1e28971a7fbe3a25c4b7733861ebc9771e4e0950fae81c8af7825b5d8b803440549af6235567b090f7f59dbfd9b6896bca74ab25933f6f32e65b12f5d56facd7f2e591818ebfbd2476c02102b9dfc69b9382a34aca902cabec67dcae8c972db19a00d375c608b8331281d6fea27d75ffd92ff541b5c15878f029034e65501821c82d138618e54857c6b0ce2c14307007a97c561c88a3f7f86b82a778b3b76a9be4a87cd18b1a83eda8d1561aa042f5858f32de17201c32e419c7f8a9c0d5c1dd4979a1817718d03876d5e5fb14e5bba867e9b49cb762d3874a90829786d6e9224c964ba0e52bbc6d241a54825a6120be0a968d2e07d4a5470455b9bd6762055c1f6e016da64e7f834b41b0116151299533a0884aa2f115ce057ea5c408ecd397bdd0219c6718565be9c549d41fd3f94b594947ca0cb43317f9457936bfa1143f9825de08eb63fbdd061c8cd9b458989f838de4af3c724aae1fb9024091b24d3fa17b34f3de321faeab4ae102347d169a0349eeaae665487f51c956adba2a4d8cc2f971651cfa8138a094cedf486d427821282205582781ca1e5d2aaf0bfbee87be13077ea59e0790d89d457889a3f2412acd8bfb3c55f373e4b7745309378f82f9bcb45d8660419f0af46fc4cff76463556787579b24a3b1d9c9605390e5d0f22fd5a95b9022721f86dbd4a7de002218469ae810ae5f1553f4d314f508e50fdbc4e863a7245bca454e75a80c5660101b30348f397de2721cd0ff9886f32d3280d2a79cac461e65692068d3fe6b7f3515764b00e2634a5f58b4064ac5b1246fe51b4f44cf5f157972bae3e7f420506e2bad634ad1d9e55997d469ca26043abe25bfbe950fedb9b42111ddc9b27cf4760d624b7935f653dae159977cb3939226ab29ac8ba8153f1ab6fc940695843d8cc7f80a1495f6f3db8708f4ea5030429936e9affd7415aa6f521a303e863e0e80247efae6e9053388439af8b5f8f205a1876e94b58581e872886211f4021034d75651cc23494fcec95d7b71f4fd5817643a65f14518c939490e113c35285ee1057cd9d5c59b4c8f000a9571b3f2a8bbb192eb0b888cdd7ef8d01fd267dfcd1be487b87535fe7096a8a91cd5e3e8851cfa94a74c322c51d86587e566a4dcf7f43477b4f4fb60d820832830b1c41710c6cfa2bf92aec394185aa80875832f7e8d8847b52518a9998d7f00ca73de2645d4d0d306ad04da2e6790645637b0314e8d7e6f752654b312458c265bb60bdc43e0b9f964df3edf164f85ac6e09a4326645fdee05eac0151ff1ea8c8cfcca5792c3431b5c386d3b41facd34edc90d7c6d5e5d9ce8541021811c620cbb08523bea8d367f36dd4c0614800de5577a2b2278fd473405b8d5e05c38b431a0d6b7c19251c4f4668908dd43900796f7acc4a299b655133100b859193e937d03db3deaa5c0a9efcaf2373a224e890c714ce04d40454d25cec2a24a30c58ee79bdf11ea590d0082b0071cbe66055f3850823183f54bd3cdb7fc319923963a8a9a396985b3c7cd1dd81aef94832aa795ea6a0bad6f60b89d0e2dae21d221d4ca2811dacb28569b2755e2a870c6649581b1eee2ef7389cb207c331a2b7e61d6b9dcd9a8cb4cb9301d8a9902e11df90b63d9137afbb2dfbd4c17958c5dcc79d519fe2a5a99c2391115e41c42642c8669e228f42d1b84749e13d370d5273a5079bbabc6c62cbca3973d1ae2bb1d2786f2de544fb62253033d203c46f2ac90e9f9b1f7bb2d6be01e2b2d53d177a1ebfd6382ae0819a4609922eb6f743450a1db5d98453b132441a73a3e4729d150a2136e938660a8558f72ceaf7bb55836d0ebc8012e90d132550ab99a27f5cbaae8efe5794c1105e9d3cd7ba0d1df5a04f774f0a02b54e2e815203ef154b6df9143c9b86eddd21b32f6ebee88008c1bd9493b8a141cdb3e09e4f801aef36c93432a4c11415b7dc67ac684b4fa46160af80a72a83950d77c1e37a6711c53e78e879775cf2ca6013337978d026fdea24f1881fc7e2eac8e1e4249bcc068e64610aa706fee619372f781d8903f2cb5f413941b9ecba4b05c2d7ac78fc8d04a10f5133c60e4499a7834e8bda518b64f1b6c1d2c6eada6ae5e08da0feed9419f701eaba13c5bbb95374f663ebf9c5d8dcbf42b734bb0776d8580b6fcf420d01c51061a3bc81cf5e8e364bb842cd94e60e5735a13aa49ab9b3149f9d422129dca13a546e4254a4923e92b5ff905582103ff218b7b9816efd78fda57849ebb9c81948df3b625011ff0ab7d6621fdcbcb03065821021ed2dceddc83589ac5335ceeb3b8b114329e49bbad5220986440be03e341341c075840b54790a36571925da0b9afcff467327e49c9cf856afcbb04b567b6e6d5673a859c5001e8a50bc7610c533dc5e87637af173f0aca86dd9e1d58f206f92b6cd1920358209f688f51d6a798d62f4b14a8b1958b14d22916ca0cb8108b91b017f238f7f2d20481a500000158207c0005730f53e3389a0057beb6b4c4ee9374b278d8c6ecb98067139df2246f6b025820000000000000000000000000000000000000000000000000000000000000000103542adf2cb0d2a8f42fd83e2c32912654a8ac76a4550458209d15a0c9d45c50955cc400ff9e8f42bf59caa0514058abad8fe9a678afb0f0570d0a2d2d6672616e6b2d67656e75696e652d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d22636f6e74657874220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f63626f720d0a0d0ab000781a6672616e6b2f646d2d63727970746f2d636f6e746578742f7631016d6d6f6e61642d746573746e657402a20001015821032de89548d6742189952342246af8e438ce63c8ad25a857690e353f3331d6c53703a20001015821036253871fdcfbb0497776db33754caaafad98c1b4b0ae4945ddf8660e27687a1a045820ed8493488028b1eed0bbd56edf022a19c6d13ee3e586792115012f14c82d97bb0558209b5957605976ee5d06728184df1d4174abacc4980fa145545ea07dc53e9640e506a2000101582102c05066c3239fc712592940a09c9272ea9b0373bbf548008e17a20c3d2a0161c207a2000101582103e84266f9de81abb5455f18083f781b09367263e3992bf51a9ea571f28619b81b08a20001015821031932bd4a3b404c1477cab87652d75ce112d24e8b1698d8cf5b1834cfc8d33fbb09582103ff218b7b9816efd78fda57849ebb9c81948df3b625011ff0ab7d6621fdcbcb030a5821021ed2dceddc83589ac5335ceeb3b8b114329e49bbad5220986440be03e341341c0b5840b54790a36571925da0b9afcff467327e49c9cf856afcbb04b567b6e6d5673a859c5001e8a50bc7610c533dc5e87637af173f0aca86dd9e1d58f206f92b6cd1920c010d050e020f020d0a2d2d6672616e6b2d67656e75696e652d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d227472616e73616374696f6e73220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f63626f720d0a0d0a81588c02f88982279f80010282c350942adf2cb0d2a8f42fd83e2c32912654a8ac76a45501a5504f4e44029d15a0c9d45c50955cc400ff9e8f42bf59caa0514058abad8fe9a678afb0f057c080a00167c2cf4fac3609c325b3ae40d05a56be2410b54b2722974a55060b06607a16a07482af1d0d0d7dbd6dbd9a5e1d273f59dd7e0a5caaa6378e9606dadcd7d43f6d0d0a2d2d6672616e6b2d67656e75696e652d3737372d2d0d0a";
fn genuine_fixture() -> ExactRequest {
    let request = ExactRequest::parse(
        hex::decode(GENUINE_T_BODY_HEX).unwrap(),
        "multipart/form-data; boundary=frank-genuine-777".into(),
    )
    .unwrap();
    assert_eq!(
        hex::encode(request.submission_identity()),
        "ef48f372334fa5ed56ce75c989924b272d386d035aade82663a75fc6ead10983"
    );
    request
}

struct NativeDirectoryFixture {
    root: tempfile::TempDir,
    registry: Arc<crate::registry::Registry>,
    directory: Arc<crate::directory_runtime::DirectoryRuntime>,
    config: cashweb_config::DirectoryConf,
}
fn admitted_source() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../../docs/protocol/cbor/vectors/dm-runtime.json"
    ))
    .unwrap()
}
impl NativeDirectoryFixture {
    async fn new() -> Self {
        use crate::{
            directory_runtime::{DirectoryRuntime, Operation},
            disabled_chain_adapter::DisabledChainAdapter,
            registry::Registry,
            store::db::Db,
        };
        let root = tempfile::tempdir().unwrap();
        let source = admitted_source();
        let case = &source["canonical_facade_final_http_case"];
        // Explicit trusted fixture clock; these public captures do NOT grant wall-clock freshness.
        std::fs::write(root.path().join("clock"), "1700000100000000000\n").unwrap();
        let principals = case["installed_principals"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(index, p)| {
                let bundle = root.path().join(format!("bundle-{index}"));
                std::fs::create_dir(&bundle).unwrap();
                cashweb_config::DirectoryPrincipalConf {
                    network: p["network"].as_str().unwrap().into(),
                    subject: p["subject"].as_str().unwrap().into(),
                    revision_zero: p["rev0T1"].as_str().unwrap().into(),
                    manifest_identity: "00".repeat(32),
                    relay_id: p["relayId"].as_str().unwrap().into(),
                    relay_identity: p["relayIdentity"]["point"].as_str().unwrap().into(),
                    endpoint: p["endpoint"].as_str().unwrap().into(),
                    binding_expiry_ns: p["bindingExpiryNs"].as_str().unwrap().into(),
                    continuity_file: root.path().join(format!("floor-{index}")),
                    bundle_root: bundle,
                    mode: "new".into(),
                }
            })
            .collect();
        let config = cashweb_config::DirectoryConf {
            clock_file: root.path().join("clock"),
            principals,
        };
        let registry = Arc::new(Registry::new(
            Db::open(root.path().join("db")).unwrap(),
            Arc::new(DisabledChainAdapter),
            bitcoinsuite_core::Net::Regtest,
        ));
        let (directory, ready) =
            DirectoryRuntime::start(registry.clone(), root.path().join("db"), config.clone())
                .unwrap();
        ready.await.unwrap().unwrap();
        let directory = Arc::new(directory);
        for (index, principal) in config.principals.iter().enumerate() {
            let exact =
                hex::decode(case["wire"]["http_attestations"][index].as_str().unwrap()).unwrap();
            directory
                .submit(
                    directory
                        .reserve(&principal.network, &principal.subject)
                        .unwrap(),
                    Operation::Put(exact.clone()),
                )
                .wait()
                .await
                .unwrap();
            let actual = directory
                .submit_snapshot(
                    directory
                        .reserve(&principal.network, &principal.subject)
                        .unwrap(),
                    crate::directory_runtime::SnapshotOperation::Current,
                )
                .wait()
                .await
                .unwrap();
            let crate::directory_runtime::AdmittedSnapshot::Current(actual) = actual else {
                panic!("actual Current");
            };
            assert_eq!(actual.evidence.attestation, exact);
            assert_eq!(hex::encode(actual.evidence.hash), principal.revision_zero);
        }
        registry
            .canonical_dm()
            .attach_directory(directory.clone())
            .unwrap();
        Self {
            root,
            registry,
            directory,
            config,
        }
    }
    async fn stop(&self) {
        self.directory.begin_shutdown();
        self.directory.wait_stopped().await;
    }
}

#[tokio::test]
async fn genuine_native_directory_exact_transport_owner_and_sealed_payment_boundary() {
    use crate::monad_outbox::{financial, MonadOutboxReconcileConfig};
    let fixture = NativeDirectoryFixture::new().await;
    let request = genuine_fixture();
    let (sender, recipient, _) = request_principals(&request, "monad-testnet").unwrap();
    let sender = current(fixture.registry.canonical_dm(), "monad-testnet", &sender)
        .await
        .unwrap();
    let recipient = current(fixture.registry.canonical_dm(), "monad-testnet", &recipient)
        .await
        .unwrap();
    crate::monad_dm_verify::verify_canonical_stamp(crate::monad_dm_verify::CanonicalStampCheckInput {
        delivery:request.delivery(), context:request.context(), sender_current:&sender, recipient_current:&recipient, recipient_evidence:None,
    }).expect("actual admitted fixture must pass the public partial stamp verifier before financial admission");
    let input = financial::validate_canonical_payment_set(
        request.clone(),
        &sender,
        &recipient,
        None,
        "monad-testnet",
        10143,
        1,
    )
    .unwrap();
    let config = MonadOutboxReconcileConfig {
        expected_chain_id: 10143,
        ..Default::default()
    };
    let claim = fixture
        .registry
        .claim_canonical_dm(input, now_ms(), &config)
        .unwrap();
    assert!(financial::verify_canonical_confirmed(&claim).is_err());
    assert!(fixture
        .registry
        .canonical_dm()
        .inbox(claim.policy.recipient().unwrap(), 0, None, 1)
        .unwrap()
        .is_empty());
    assert!(fixture
        .registry
        .canonical_dm()
        .find_request(&request)
        .unwrap()
        .unwrap()
        .request
        .exact_equal(&request));
    assert_eq!(claim.policy.sender_t1, sender.evidence.hash);
    assert_eq!(claim.policy.recipient_t1, recipient.evidence.hash);
    // No legacy profile/protobuf writer or synthetic Current was involved.
    fixture.stop().await;
}

#[tokio::test]
async fn weak_directory_hook_preserves_same_owner_rejects_other_live_owner_and_ordinary_drop() {
    let fixture = NativeDirectoryFixture::new().await;
    let owner = fixture.registry.canonical_dm();
    owner
        .attach_directory(Arc::new(fixture.directory.as_ref().clone()))
        .unwrap();
    assert!(owner.directory().is_some()); // a temporary clone cannot replace the live original hook
    owner.attach_directory(fixture.directory.clone()).unwrap();
    let other = NativeDirectoryFixture::new().await;
    assert_eq!(
        owner.attach_directory(other.directory.clone()),
        Err(CanonicalError::Conflict)
    );
    other.stop().await;
    fixture.stop().await;
    let NativeDirectoryFixture {
        root,
        registry,
        directory,
        mut config,
    } = fixture;
    drop(directory);
    assert!(registry.canonical_dm().directory().is_none());
    // A real reopened owner may replace only the expired weak hook.
    for principal in &mut config.principals {
        principal.mode = "reopen".into();
    }
    let (reopened, ready) = crate::directory_runtime::DirectoryRuntime::start(
        registry.clone(),
        root.path().join("db"),
        config,
    )
    .unwrap();
    ready.await.unwrap().unwrap();
    let reopened = Arc::new(reopened);
    registry
        .canonical_dm()
        .attach_directory(reopened.clone())
        .unwrap();
    assert!(registry
        .canonical_dm()
        .directory()
        .unwrap()
        .same_owner(&reopened));
    reopened.begin_shutdown();
    reopened.wait_stopped().await;
}

#[tokio::test]
async fn ordinary_directory_drop_releases_registry_before_reopen() {
    let fixture = NativeDirectoryFixture::new().await;
    let NativeDirectoryFixture {
        root,
        registry,
        directory,
        mut config,
    } = fixture;
    let weak = Arc::downgrade(&registry);
    drop(directory);
    drop(registry);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while weak.upgrade().is_some() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("ordinary owner drop must not retain the registry/database cycle");
    let registry = Arc::new(crate::registry::Registry::new(
        crate::store::db::Db::open(root.path().join("db")).unwrap(),
        Arc::new(crate::disabled_chain_adapter::DisabledChainAdapter),
        bitcoinsuite_core::Net::Regtest,
    ));
    for principal in &mut config.principals {
        principal.mode = "reopen".into();
    }
    let (directory, ready) =
        crate::directory_runtime::DirectoryRuntime::start(registry, root.path().join("db"), config)
            .unwrap();
    ready.await.unwrap().unwrap();
    directory.begin_shutdown();
    directory.wait_stopped().await;
}

async fn serve_http(
    router: axum::Router,
) -> (
    String,
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        axum::Server::from_tcp(listener)
            .unwrap()
            .serve(router.into_make_service())
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{address}"), stop, task)
}
fn server(fixture: &NativeDirectoryFixture, rpc: &str) -> super::super::server::RegistryServer {
    let config = crate::monad_outbox::MonadOutboxReconcileConfig {
        expected_chain_id: 10143,
        receipt_poll_attempts: 1,
        poll_interval: std::time::Duration::ZERO,
        ..Default::default()
    };
    super::super::server::RegistryServer {
        registry: fixture.registry.clone(),
        peers: Arc::new(crate::p2p::peers::Peers::new(
            "http://127.0.0.1:1".into(),
            vec![],
        )),
        pop_gate: Arc::new(crate::http::pop_protection::PopGate::from_conf_if_enabled(
            &crate::test_instance::placeholder_pop_conf(),
        )),
        curated_defaults: Arc::new(vec![]),
        monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::enabled(
            crate::monad_http::HttpTransport::new(rpc.parse().unwrap()),
            Arc::new(config),
            1,
            b"MONT".to_vec(),
        ),
        evm_rpc: None,
        bitcoin_proxy: None,
    }
}
async fn public_p_signature(root: &std::path::Path, digest: [u8; 32], point: &str) -> Vec<u8> {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let script = root.join("public-p-signer.cjs");
    std::fs::write(&script, r#"
const repo=process.argv[2], digest=process.argv[3], expected=process.argv[4];
const Module=require('module'),resolve=Module._resolveFilename;
Module._resolveFilename=function(name,parent,...args){
 if(name==='@frank/crypto-box')name=repo+'/packages/crypto-box/dist/index.js';
 if(name==='@frank/codec')name=repo+'/packages/frank-codec/src/index.ts';
 if(name==='@frank/nakamoto')name=repo+'/packages/nakamoto/dist/index.js';
 else if(name.startsWith('@frank/nakamoto/'))name=repo+'/packages/nakamoto/dist/'+name.slice('@frank/nakamoto/'.length)+'.js';
 return resolve.call(this,name,parent,...args);
};

const {createMonadWalletMaterial}=require(repo+'/packages/wallet/monad-wallet-material.ts');
const vector=require(repo+'/packages/domain-roots/vectors/domain-roots-v1.json').vectors[1];
const roots=Object.fromEntries([['evm','evm-wallet'],['authentication','identity-authentication'],['messaging','messaging-encryption']].map(([key,purpose])=>[key,{registry:'frank-domain-roots-v1',purpose,bytes:Uint8Array.from(Buffer.from(vector.outputs[purpose],'hex'))}]));
const material=createMonadWalletMaterial(roots);
try { if(Buffer.from(material.identity.compressedPubKey).toString('hex')!==expected)throw Error('actual public P derivation mismatch'); process.stdout.write(Buffer.from(material.identity.signHash(Buffer.from(digest,'hex'))).toString('hex')); } finally { material.dispose(); }
"#).unwrap();
    let point = point.to_owned();
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("node")
            .arg("-r")
            .arg(repo.join("node_modules/tsx/dist/cjs/index.cjs"))
            .arg(script)
            .arg(repo)
            .arg(hex::encode(digest))
            .arg(point)
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    assert!(
        output.status.success(),
        "owned public wallet P signer prerequisite or invocation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    hex::decode(output.stdout).unwrap()
}
#[tokio::test]
async fn actual_http_canonical_public_admission_p_authenticated_inbox_and_nonce_replay() {
    use crate::monad_http::Hash32;
    use crate::monad_mailbox::{MailboxChallenge, MailboxRequestBinding, MailboxResource};
    let fixture = NativeDirectoryFixture::new().await;
    let request = genuine_fixture();
    let raw = request.raw_transactions().next().unwrap().to_vec();
    let decoded = crate::monad_evm_tx::decode_signed_transaction(&raw).unwrap();
    let hash = decoded.tx_hash.to_hex();
    let from = decoded.sender.to_hex();
    let to = decoded.destination.unwrap().to_hex();
    let input = format!("0x{}", hex::encode(&decoded.input));
    let raw_hex = format!("0x{}", hex::encode(raw));
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = calls.clone();
    let rpc = axum::Router::new().route("/", axum::routing::post(move |Json(query):Json<serde_json::Value>| {
        let (hash,from,to,input,raw) = (hash.clone(),from.clone(),to.clone(),input.clone(),raw_hex.clone()); let calls = observed.clone();
        async move {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(query["params"][0].as_str(), Some(hash.as_str()));
            let result = match query["method"].as_str().unwrap() {
                "eth_getTransactionByHash" => serde_json::json!({"hash":hash,"from":from,"to":to,"value":"0x1","input":input}),
                "eth_getRawTransactionByHash" => serde_json::json!(raw),
                "eth_getTransactionReceipt" => serde_json::json!({"transactionHash":hash,"blockHash":Hash32([1;32]).to_hex(),"blockNumber":"0x1","transactionIndex":"0x0","from":from,"to":to,"gasUsed":"0x5208","status":"0x1","logs":[]}),
                other => panic!("unexpected financial RPC {other}"),
            };
            Json(serde_json::json!({"jsonrpc":"2.0","id":query["id"],"result":result}))
        }
    }));
    let (rpc_url, rpc_stop, rpc_task) = serve_http(rpc).await;
    let runtime_server = server(&fixture, &rpc_url);
    let (url, http_stop, http_task) = serve_http(
        runtime_server
            .clone()
            .into_router_with_directory(Some(fixture.directory.clone())),
    )
    .await;
    let client = reqwest::Client::new();
    let response = client
        .put(format!("{url}/message/monad/cbor"))
        .header("content-type", request.content_type())
        .body(request.body().to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let accepted: serde_json::Value =
        serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    assert_eq!(accepted["phase"], "delivered");
    assert_eq!(
        accepted["identity"]["submission_identity"],
        hex::encode(request.submission_identity())
    );
    assert!(accepted["mailbox_committed_at_ms"].as_i64().unwrap() > 0);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 3);
    let recipient = accepted["identity"]["recipient"].as_str().unwrap();
    let point = &fixture.config.principals[1].subject;
    let challenge_response = client.get(format!("{url}/message/monad/cbor/auth/{recipient}?resource=inbox&since=0&limit=50&max_bytes=8388608")).header("x-frank-mailbox-subject", point).send().await.unwrap().error_for_status().unwrap().bytes().await.unwrap();
    let challenge: serde_json::Value = serde_json::from_slice(&challenge_response).unwrap();
    assert_eq!(challenge["network_tag"], "4d4f4e54");
    let token = MailboxChallenge {
        epoch: hash_hex(challenge["epoch"].as_str().unwrap()).unwrap(),
        nonce: hash_hex(challenge["nonce"].as_str().unwrap()).unwrap(),
        token: hash_hex(challenge["token"].as_str().unwrap()).unwrap(),
        expires_at_ms: challenge["expires_at_ms"].as_i64().unwrap(),
    };
    let binding = MailboxRequestBinding {
        resource: MailboxResource::Inbox,
        recipient: Address::from_hex(recipient).unwrap(),
        since: 0,
        cursor: None,
        limit: 50,
        max_bytes: MAX_REQUEST_BYTES,
        recovery_payload_hash: None,
        recovery_obligation_id: None,
    };
    let digest = Sha256::digest(
        super::super::monad_message::mailbox_auth_preimage(token, &binding, b"MONT").into(),
    );
    let signature = public_p_signature(
        fixture.root.path(),
        digest.as_slice().try_into().unwrap(),
        point,
    )
    .await;
    let signed = || {
        client
            .get(format!(
                "{url}/message/monad/cbor/inbox/{recipient}?since=0&limit=50&max_bytes=8388608"
            ))
            .header("x-frank-mailbox-subject", point)
            .header(
                "x-frank-mailbox-epoch",
                challenge["epoch"].as_str().unwrap(),
            )
            .header(
                "x-frank-mailbox-nonce",
                challenge["nonce"].as_str().unwrap(),
            )
            .header(
                "x-frank-mailbox-token",
                challenge["token"].as_str().unwrap(),
            )
            .header("x-frank-mailbox-expires-at-ms", token.expires_at_ms)
            .header("x-frank-mailbox-signature", hex::encode(&signature))
    };
    let response = signed().send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let media = response.headers()["content-type"]
        .to_str()
        .unwrap()
        .to_owned();
    let boundary = parse_boundary(&media, "multipart/mixed").unwrap();
    let bytes = response.bytes().await.unwrap();
    assert!(bytes.starts_with(
        format!("--{boundary}\r\nContent-Disposition: inline; name=\"record\"").as_bytes()
    ));
    assert!(bytes.ends_with(format!("--{boundary}--\r\n").as_bytes()));
    assert!(find(&bytes, request.delivery()).is_some());
    assert!(find(&bytes, request.context()).is_some());
    assert_eq!(
        signed().send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    // A durable exact retry must not make more financial calls or publish a second inbox row.
    let response = client
        .put(format!("{url}/message/monad/cbor"))
        .header("content-type", request.content_type())
        .body(request.body().to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 3);
    drop(client);
    http_stop.send(()).unwrap();
    http_task.await.unwrap();
    rpc_stop.send(()).unwrap();
    rpc_task.await.unwrap();
    fixture.stop().await;
}
