//! Independent T public-encoder bytes. These are offline signed bytes, not Directory or receipt authority.
use super::*;

// Captured from T8a4a46c public freezeCanonicalRequest, offline key1/chain10143/value1.
// Every body below was re-signed as a plain transfer with empty calldata (#826) by
// tests/support/canonical_dm_plain_transfer_fixtures.cjs; rerunning it must change nothing.
const T_BODY_HEX: &str = "2d2d6672616e6b2d666978747572652d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d2264656c6976657279220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f766e642e6672616e6b2e63626f720d0a0d0a46524e4b0100000890a400010101020103590885a5006d6d6f6e61642d746573746e657401a20001015821031932bd4a3b404c1477cab87652d75ce112d24e8b1698d8cf5b1834cfc8d33fbb025907a246524e4b0100000799a40005010202020359078ea8006d6d6f6e61642d746573746e657401a20001015821032de89548d6742189952342246af8e438ce63c8ad25a857690e353f3331d6c53702a20001015821036253871fdcfbb0497776db33754caaafad98c1b4b0ae4945ddf8660e27687a1a03010459069da6000201010219ff0003582043bed8daec2f39d9f1af1f292b277a5270772b80e8fb9eef3a99b48689039b6904582102efe3593d7c4ed3419a7055df81219a5d88eea56da4931dd5c2131f22f98c2fee05590649ad4f6a4781a00434ce5a2c2f9b7548a27a614c0f2ee0c482e118a60d1e28971a7fbe3a25c4b7733861ebc9771e4e0950fae81c8af7825b5d8b803440549af6235567b090f7f59dbfd9b6896bca74ab25933f6f32e65b12f5d56facd7f2e591818ebfbd2476c02102b9dfc69b9382a34aca902cabec67dcae8c972db19a00d375c608b8331281d6fea27d75ffd92ff541b5c15878f029034e65501821c82d138618e54857c6b0ce2c14307007a97c561c88a3f7f86b82a778b3b76a9be4a87cd18b1a83eda8d1561aa042f5858f32de17201c32e419c7f8a9c0d5c1dd4979a1817718d03876d5e5fb14e5bba867e9b49cb762d3874a90829786d6e9224c964ba0e52bbc6d241a54825a6120be0a968d2e07d4a5470455b9bd6762055c1f6e016da64e7f834b41b0116151299533a0884aa2f115ce057ea5c408ecd397bdd0219c6718565be9c549d41fd3f94b594947ca0cb43317f9457936bfa1143f9825de08eb63fbdd061c8cd9b458989f838de4af3c724aae1fb9024091b24d3fa17b34f3de321faeab4ae102347d169a0349eeaae665487f51c956adba2a4d8cc2f971651cfa8138a094cedf486d427821282205582781ca1e5d2aaf0bfbee87be13077ea59e0790d89d457889a3f2412acd8bfb3c55f373e4b7745309378f82f9bcb45d8660419f0af46fc4cff76463556787579b24a3b1d9c9605390e5d0f22fd5a95b9022721f86dbd4a7de002218469ae810ae5f1553f4d314f508e50fdbc4e863a7245bca454e75a80c5660101b30348f397de2721cd0ff9886f32d3280d2a79cac461e65692068d3fe6b7f3515764b00e2634a5f58b4064ac5b1246fe51b4f44cf5f157972bae3e7f420506e2bad634ad1d9e55997d469ca26043abe25bfbe950fedb9b42111ddc9b27cf4760d624b7935f653dae159977cb3939226ab29ac8ba8153f1ab6fc940695843d8cc7f80a1495f6f3db8708f4ea5030429936e9affd7415aa6f521a303e863e0e80247efae6e9053388439af8b5f8f205a1876e94b58581e872886211f4021034d75651cc23494fcec95d7b71f4fd5817643a65f14518c939490e113c35285ee1057cd9d5c59b4c8f000a9571b3f2a8bbb192eb0b888cdd7ef8d01fd267dfcd1be487b87535fe7096a8a91cd5e3e8851cfa94a74c322c51d86587e566a4dcf7f43477b4f4fb60d820832830b1c41710c6cfa2bf92aec394185aa80875832f7e8d8847b52518a9998d7f00ca73de2645d4d0d306ad04da2e6790645637b0314e8d7e6f752654b312458c265bb60bdc43e0b9f964df3edf164f85ac6e09a4326645fdee05eac0151ff1ea8c8cfcca5792c3431b5c386d3b41facd34edc90d7c6d5e5d9ce8541021811c620cbb08523bea8d367f36dd4c0614800de5577a2b2278fd473405b8d5e05c38b431a0d6b7c19251c4f4668908dd43900796f7acc4a299b655133100b859193e937d03db3deaa5c0a9efcaf2373a224e890c714ce04d40454d25cec2a24a30c58ee79bdf11ea590d0082b0071cbe66055f3850823183f54bd3cdb7fc319923963a8a9a396985b3c7cd1dd81aef94832aa795ea6a0bad6f60b89d0e2dae21d221d4ca2811dacb28569b2755e2a870c6649581b1eee2ef7389cb207c331a2b7e61d6b9dcd9a8cb4cb9301d8a9902e11df90b63d9137afbb2dfbd4c17958c5dcc79d519fe2a5a99c2391115e41c42642c8669e228f42d1b84749e13d370d5273a5079bbabc6c62cbca3973d1ae2bb1d2786f2de544fb62253033d203c46f2ac90e9f9b1f7bb2d6be01e2b2d53d177a1ebfd6382ae0819a4609922eb6f743450a1db5d98453b132441a73a3e4729d150a2136e938660a8558f72ceaf7bb55836d0ebc8012e90d132550ab99a27f5cbaae8efe5794c1105e9d3cd7ba0d1df5a04f774f0a02b54e2e815203ef154b6df9143c9b86eddd21b32f6ebee88008c1bd9493b8a141cdb3e09e4f801aef36c93432a4c11415b7dc67ac684b4fa46160af80a72a83950d77c1e37a6711c53e78e879775cf2ca6013337978d026fdea24f1881fc7e2eac8e1e4249bcc068e64610aa706fee619372f781d8903f2cb5f413941b9ecba4b05c2d7ac78fc8d04a10f5133c60e4499a7834e8bda518b64f1b6c1d2c6eada6ae5e08da0feed9419f701eaba13c5bbb95374f663ebf9c5d8dcbf42b734bb0776d8580b6fcf420d01c51061a3bc81cf5e8e364bb842cd94e60e5735a13aa49ab9b3149f9d422129dca13a546e4254a4923e92b5ff905582103ff218b7b9816efd78fda57849ebb9c81948df3b625011ff0ab7d6621fdcbcb03065821021ed2dceddc83589ac5335ceeb3b8b114329e49bbad5220986440be03e341341c075840b54790a36571925da0b9afcff467327e49c9cf856afcbb04b567b6e6d5673a859c5001e8a50bc7610c533dc5e87637af173f0aca86dd9e1d58f206f92b6cd1920358209f688f51d6a798d62f4b14a8b1958b14d22916ca0cb8108b91b017f238f7f2d20481a5000001582080ae3d65a61d9ed00144129b5fe5a8b1607bafae56d594c73ebc257e466d8094025820000000000000000000000000000000000000000000000000000000000000000103542adf2cb0d2a8f42fd83e2c32912654a8ac76a4550458209d15a0c9d45c50955cc400ff9e8f42bf59caa0514058abad8fe9a678afb0f0570d0a2d2d6672616e6b2d666978747572652d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d22636f6e74657874220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f63626f720d0a0d0ab000781a6672616e6b2f646d2d63727970746f2d636f6e746578742f7631016d6d6f6e61642d746573746e657402a20001015821032de89548d6742189952342246af8e438ce63c8ad25a857690e353f3331d6c53703a20001015821036253871fdcfbb0497776db33754caaafad98c1b4b0ae4945ddf8660e27687a1a045820ed8493488028b1eed0bbd56edf022a19c6d13ee3e586792115012f14c82d97bb0558209b5957605976ee5d06728184df1d4174abacc4980fa145545ea07dc53e9640e506a2000101582102c05066c3239fc712592940a09c9272ea9b0373bbf548008e17a20c3d2a0161c207a2000101582103e84266f9de81abb5455f18083f781b09367263e3992bf51a9ea571f28619b81b08a20001015821031932bd4a3b404c1477cab87652d75ce112d24e8b1698d8cf5b1834cfc8d33fbb09582103ff218b7b9816efd78fda57849ebb9c81948df3b625011ff0ab7d6621fdcbcb030a5821021ed2dceddc83589ac5335ceeb3b8b114329e49bbad5220986440be03e341341c0b5840b54790a36571925da0b9afcff467327e49c9cf856afcbb04b567b6e6d5673a859c5001e8a50bc7610c533dc5e87637af173f0aca86dd9e1d58f206f92b6cd1920c010d050e020f020d0a2d2d6672616e6b2d666978747572652d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d227472616e73616374696f6e73220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f63626f720d0a0d0a81586702f86482279f800102825208942adf2cb0d2a8f42fd83e2c32912654a8ac76a4550180c001a019e26823936e9d556db4728e30c8c0a1f90b4e9479cfbd33759f529b4e450fe7a05383c03f1877695b615dd9401e6472ad5184bf919f361b7cb33e0ffee6060b150d0a2d2d6672616e6b2d666978747572652d3737372d2d0d0a";
const T_CONTENT_TYPE: &str = "multipart/form-data; boundary=frank-fixture-777";
fn fixture() -> ExactRequest {
    ExactRequest::parse(hex::decode(T_BODY_HEX).unwrap(), T_CONTENT_TYPE.into()).unwrap()
}

#[test]
fn independent_transport_original_body_and_ordinary_identity_are_exact() {
    let request = fixture();
    assert_eq!(
        hex::encode(request.submission_identity()),
        "c6f2807b73e42a6c60c0e0f20307f2ff2779d6479f5d472b049a7395029413c9"
    );
    assert_eq!(request.body(), hex::decode(T_BODY_HEX).unwrap());
    assert_eq!(request.content_type(), T_CONTENT_TYPE);
    assert_eq!(request.transaction_count(), 1);
    assert_eq!(hex::encode(request.raw_transactions().next().unwrap()), "02f86482279f800102825208942adf2cb0d2a8f42fd83e2c32912654a8ac76a4550180c001a019e26823936e9d556db4728e30c8c0a1f90b4e9479cfbd33759f529b4e450fe7a05383c03f1877695b615dd9401e6472ad5184bf919f361b7cb33e0ffee6060b15");
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
    assert_eq!(
        transaction_ranges(&[0x80], 0).unwrap(),
        Vec::<std::ops::Range<usize>>::new()
    );
    for bytes in [
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
// Ethers test-key1 re-signs the existing raw as a plain transfer; public type1 writer + freeze API.
// Same admitted payload/context/T1s. This is a strict HTTP chain fixture, not funded-chain finality.
const GENUINE_T_BODY_HEX: &str = "2d2d6672616e6b2d67656e75696e652d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d2264656c6976657279220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f766e642e6672616e6b2e63626f720d0a0d0a46524e4b0100000890a400010101020103590885a5006d6d6f6e61642d746573746e657401a20001015821031932bd4a3b404c1477cab87652d75ce112d24e8b1698d8cf5b1834cfc8d33fbb025907a246524e4b0100000799a40005010202020359078ea8006d6d6f6e61642d746573746e657401a20001015821032de89548d6742189952342246af8e438ce63c8ad25a857690e353f3331d6c53702a20001015821036253871fdcfbb0497776db33754caaafad98c1b4b0ae4945ddf8660e27687a1a03010459069da6000201010219ff0003582043bed8daec2f39d9f1af1f292b277a5270772b80e8fb9eef3a99b48689039b6904582102efe3593d7c4ed3419a7055df81219a5d88eea56da4931dd5c2131f22f98c2fee05590649ad4f6a4781a00434ce5a2c2f9b7548a27a614c0f2ee0c482e118a60d1e28971a7fbe3a25c4b7733861ebc9771e4e0950fae81c8af7825b5d8b803440549af6235567b090f7f59dbfd9b6896bca74ab25933f6f32e65b12f5d56facd7f2e591818ebfbd2476c02102b9dfc69b9382a34aca902cabec67dcae8c972db19a00d375c608b8331281d6fea27d75ffd92ff541b5c15878f029034e65501821c82d138618e54857c6b0ce2c14307007a97c561c88a3f7f86b82a778b3b76a9be4a87cd18b1a83eda8d1561aa042f5858f32de17201c32e419c7f8a9c0d5c1dd4979a1817718d03876d5e5fb14e5bba867e9b49cb762d3874a90829786d6e9224c964ba0e52bbc6d241a54825a6120be0a968d2e07d4a5470455b9bd6762055c1f6e016da64e7f834b41b0116151299533a0884aa2f115ce057ea5c408ecd397bdd0219c6718565be9c549d41fd3f94b594947ca0cb43317f9457936bfa1143f9825de08eb63fbdd061c8cd9b458989f838de4af3c724aae1fb9024091b24d3fa17b34f3de321faeab4ae102347d169a0349eeaae665487f51c956adba2a4d8cc2f971651cfa8138a094cedf486d427821282205582781ca1e5d2aaf0bfbee87be13077ea59e0790d89d457889a3f2412acd8bfb3c55f373e4b7745309378f82f9bcb45d8660419f0af46fc4cff76463556787579b24a3b1d9c9605390e5d0f22fd5a95b9022721f86dbd4a7de002218469ae810ae5f1553f4d314f508e50fdbc4e863a7245bca454e75a80c5660101b30348f397de2721cd0ff9886f32d3280d2a79cac461e65692068d3fe6b7f3515764b00e2634a5f58b4064ac5b1246fe51b4f44cf5f157972bae3e7f420506e2bad634ad1d9e55997d469ca26043abe25bfbe950fedb9b42111ddc9b27cf4760d624b7935f653dae159977cb3939226ab29ac8ba8153f1ab6fc940695843d8cc7f80a1495f6f3db8708f4ea5030429936e9affd7415aa6f521a303e863e0e80247efae6e9053388439af8b5f8f205a1876e94b58581e872886211f4021034d75651cc23494fcec95d7b71f4fd5817643a65f14518c939490e113c35285ee1057cd9d5c59b4c8f000a9571b3f2a8bbb192eb0b888cdd7ef8d01fd267dfcd1be487b87535fe7096a8a91cd5e3e8851cfa94a74c322c51d86587e566a4dcf7f43477b4f4fb60d820832830b1c41710c6cfa2bf92aec394185aa80875832f7e8d8847b52518a9998d7f00ca73de2645d4d0d306ad04da2e6790645637b0314e8d7e6f752654b312458c265bb60bdc43e0b9f964df3edf164f85ac6e09a4326645fdee05eac0151ff1ea8c8cfcca5792c3431b5c386d3b41facd34edc90d7c6d5e5d9ce8541021811c620cbb08523bea8d367f36dd4c0614800de5577a2b2278fd473405b8d5e05c38b431a0d6b7c19251c4f4668908dd43900796f7acc4a299b655133100b859193e937d03db3deaa5c0a9efcaf2373a224e890c714ce04d40454d25cec2a24a30c58ee79bdf11ea590d0082b0071cbe66055f3850823183f54bd3cdb7fc319923963a8a9a396985b3c7cd1dd81aef94832aa795ea6a0bad6f60b89d0e2dae21d221d4ca2811dacb28569b2755e2a870c6649581b1eee2ef7389cb207c331a2b7e61d6b9dcd9a8cb4cb9301d8a9902e11df90b63d9137afbb2dfbd4c17958c5dcc79d519fe2a5a99c2391115e41c42642c8669e228f42d1b84749e13d370d5273a5079bbabc6c62cbca3973d1ae2bb1d2786f2de544fb62253033d203c46f2ac90e9f9b1f7bb2d6be01e2b2d53d177a1ebfd6382ae0819a4609922eb6f743450a1db5d98453b132441a73a3e4729d150a2136e938660a8558f72ceaf7bb55836d0ebc8012e90d132550ab99a27f5cbaae8efe5794c1105e9d3cd7ba0d1df5a04f774f0a02b54e2e815203ef154b6df9143c9b86eddd21b32f6ebee88008c1bd9493b8a141cdb3e09e4f801aef36c93432a4c11415b7dc67ac684b4fa46160af80a72a83950d77c1e37a6711c53e78e879775cf2ca6013337978d026fdea24f1881fc7e2eac8e1e4249bcc068e64610aa706fee619372f781d8903f2cb5f413941b9ecba4b05c2d7ac78fc8d04a10f5133c60e4499a7834e8bda518b64f1b6c1d2c6eada6ae5e08da0feed9419f701eaba13c5bbb95374f663ebf9c5d8dcbf42b734bb0776d8580b6fcf420d01c51061a3bc81cf5e8e364bb842cd94e60e5735a13aa49ab9b3149f9d422129dca13a546e4254a4923e92b5ff905582103ff218b7b9816efd78fda57849ebb9c81948df3b625011ff0ab7d6621fdcbcb03065821021ed2dceddc83589ac5335ceeb3b8b114329e49bbad5220986440be03e341341c075840b54790a36571925da0b9afcff467327e49c9cf856afcbb04b567b6e6d5673a859c5001e8a50bc7610c533dc5e87637af173f0aca86dd9e1d58f206f92b6cd1920358209f688f51d6a798d62f4b14a8b1958b14d22916ca0cb8108b91b017f238f7f2d20481a5000001582080ae3d65a61d9ed00144129b5fe5a8b1607bafae56d594c73ebc257e466d8094025820000000000000000000000000000000000000000000000000000000000000000103542adf2cb0d2a8f42fd83e2c32912654a8ac76a4550458209d15a0c9d45c50955cc400ff9e8f42bf59caa0514058abad8fe9a678afb0f0570d0a2d2d6672616e6b2d67656e75696e652d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d22636f6e74657874220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f63626f720d0a0d0ab000781a6672616e6b2f646d2d63727970746f2d636f6e746578742f7631016d6d6f6e61642d746573746e657402a20001015821032de89548d6742189952342246af8e438ce63c8ad25a857690e353f3331d6c53703a20001015821036253871fdcfbb0497776db33754caaafad98c1b4b0ae4945ddf8660e27687a1a045820ed8493488028b1eed0bbd56edf022a19c6d13ee3e586792115012f14c82d97bb0558209b5957605976ee5d06728184df1d4174abacc4980fa145545ea07dc53e9640e506a2000101582102c05066c3239fc712592940a09c9272ea9b0373bbf548008e17a20c3d2a0161c207a2000101582103e84266f9de81abb5455f18083f781b09367263e3992bf51a9ea571f28619b81b08a20001015821031932bd4a3b404c1477cab87652d75ce112d24e8b1698d8cf5b1834cfc8d33fbb09582103ff218b7b9816efd78fda57849ebb9c81948df3b625011ff0ab7d6621fdcbcb030a5821021ed2dceddc83589ac5335ceeb3b8b114329e49bbad5220986440be03e341341c0b5840b54790a36571925da0b9afcff467327e49c9cf856afcbb04b567b6e6d5673a859c5001e8a50bc7610c533dc5e87637af173f0aca86dd9e1d58f206f92b6cd1920c010d050e020f020d0a2d2d6672616e6b2d67656e75696e652d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d227472616e73616374696f6e73220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f63626f720d0a0d0a81586702f86482279f800102825208942adf2cb0d2a8f42fd83e2c32912654a8ac76a4550180c001a019e26823936e9d556db4728e30c8c0a1f90b4e9479cfbd33759f529b4e450fe7a05383c03f1877695b615dd9401e6472ad5184bf919f361b7cb33e0ffee6060b150d0a2d2d6672616e6b2d67656e75696e652d3737372d2d0d0a";
fn genuine_fixture() -> ExactRequest {
    let request = ExactRequest::parse(
        hex::decode(GENUINE_T_BODY_HEX).unwrap(),
        "multipart/form-data; boundary=frank-genuine-777".into(),
    )
    .unwrap();
    assert_eq!(
        hex::encode(request.submission_identity()),
        "c6f2807b73e42a6c60c0e0f20307f2ff2779d6479f5d472b049a7395029413c9"
    );
    request
}

/// One account of the captured case: only its public key and first entry, nothing installed.
pub(crate) struct Account {
    pub(crate) network: String,
    pub(crate) subject: String,
    pub(crate) revision_zero: String,
}
pub(crate) struct NativeDirectoryFixture {
    pub(crate) root: tempfile::TempDir,
    pub(crate) registry: Arc<crate::registry::Registry>,
    pub(crate) directory: Arc<crate::directory_runtime::DirectoryRuntime>,
    /// The two accounts of the captured case. They are not part of any relay configuration.
    pub(crate) accounts: Vec<Account>,
    config: cashweb_config::DirectoryConf,
    clock: crate::directory_runtime::TestClock,
}
fn admitted_source() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../../docs/protocol/cbor/vectors/dm-runtime.json"
    ))
    .unwrap()
}
impl NativeDirectoryFixture {
    pub(crate) async fn new() -> Self {
        Self::publishing(|_| true).await
    }
    /// A relay that knows only its own tuple. The accounts `publishes` selects publish their own
    /// signed entries; the others have simply never published here.
    pub(crate) async fn publishing(publishes: impl Fn(usize) -> bool) -> Self {
        // The relay is the one the recipient's entry names. The sender's entry names another.
        Self::homed(1, publishes).await
    }
    /// As [`Self::publishing`], on the relay that captured account `home` names in its entry.
    pub(crate) async fn homed(home: usize, publishes: impl Fn(usize) -> bool) -> Self {
        use crate::{
            directory_runtime::{DirectoryRuntime, Operation, TestClock},
            disabled_chain_adapter::DisabledChainAdapter,
            registry::Registry,
            store::db::Db,
        };
        let root = tempfile::tempdir().unwrap();
        let source = admitted_source();
        let case = &source["canonical_facade_final_http_case"];
        // These public captures are signed for 2023; the relay runs on a clock set to their time.
        let clock = TestClock::at(1700000100);
        let captured = case["installed_principals"].as_array().unwrap();
        let accounts = captured
            .iter()
            .map(|p| Account {
                network: p["network"].as_str().unwrap().into(),
                subject: p["subject"].as_str().unwrap().into(),
                revision_zero: p["rev0T1"].as_str().unwrap().into(),
            })
            .collect::<Vec<_>>();
        let home = &captured[home];
        let config: cashweb_config::DirectoryConf = serde_json::from_value(serde_json::json!({
            "network": home["network"],
            "relay_id": home["relayId"],
            "relay_identity": home["relayIdentity"]["point"],
            "endpoint": home["endpoint"],
            "binding_expiry_ns": home["bindingExpiryNs"],
        }))
        .unwrap();
        let registry = Arc::new(Registry::new(
            Db::open(root.path().join("db")).unwrap(),
            Arc::new(DisabledChainAdapter),
            bitcoinsuite_core::Net::Regtest,
        ));
        let (directory, ready) =
            DirectoryRuntime::start_with_clock(registry.clone(), config.clone(), clock.clock())
                .unwrap();
        ready.await.unwrap().unwrap();
        let directory = Arc::new(directory);
        for (index, account) in accounts.iter().enumerate() {
            if !publishes(index) {
                continue;
            }
            let exact =
                hex::decode(case["wire"]["http_attestations"][index].as_str().unwrap()).unwrap();
            directory
                .submit(
                    directory
                        .reserve(&account.network, &account.subject)
                        .unwrap(),
                    Operation::Put(exact.clone()),
                )
                .wait()
                .await
                .unwrap();
            let actual = directory
                .submit_snapshot(
                    directory
                        .reserve(&account.network, &account.subject)
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
            assert_eq!(hex::encode(actual.evidence.hash), account.revision_zero);
        }
        registry
            .canonical_dm()
            .attach_directory(directory.clone())
            .unwrap();
        Self {
            root,
            registry,
            directory,
            accounts,
            config,
            clock,
        }
    }
    pub(crate) async fn stop(&self) {
        self.directory.begin_shutdown();
        self.directory.wait_stopped().await;
    }
    async fn reopen(self) -> Self {
        self.stop().await;
        let Self {
            root,
            registry,
            directory,
            accounts,
            config,
            clock,
        } = self;
        let previous = Arc::downgrade(&registry);
        drop(directory);
        drop(registry);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while previous.upgrade().is_some() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("old native/registry owner must release the database before reopen");
        let registry = Arc::new(crate::registry::Registry::new(
            crate::store::db::Db::open(root.path().join("db")).unwrap(),
            Arc::new(crate::disabled_chain_adapter::DisabledChainAdapter),
            bitcoinsuite_core::Net::Regtest,
        ));
        // Nothing is re-published: the restarted relay finds the accounts in its own database.
        let (directory, ready) = crate::directory_runtime::DirectoryRuntime::start_with_clock(
            registry.clone(),
            config.clone(),
            clock.clock(),
        )
        .unwrap();
        ready.await.unwrap().unwrap();
        let directory = Arc::new(directory);
        registry
            .canonical_dm()
            .attach_directory(directory.clone())
            .unwrap();
        Self {
            root,
            registry,
            directory,
            accounts,
            config,
            clock,
        }
    }
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
        root: _root,
        registry,
        directory,
        config,
        clock,
        ..
    } = fixture;
    drop(directory);
    assert!(registry.canonical_dm().directory().is_none());
    // A real reopened owner may replace only the expired weak hook.
    let (reopened, ready) = crate::directory_runtime::DirectoryRuntime::start_with_clock(
        registry.clone(),
        config,
        clock.clock(),
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
        config,
        clock,
        ..
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
    let (directory, ready) = crate::directory_runtime::DirectoryRuntime::start_with_clock(
        registry,
        config,
        clock.clock(),
    )
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
    server_with(fixture, rpc, 1, std::time::Duration::from_secs(10))
}
/// A relay requiring `min_value_wei` per paid message and giving its node `rpc_timeout` to
/// answer one call.
fn server_with(
    fixture: &NativeDirectoryFixture,
    rpc: &str,
    min_value_wei: u128,
    rpc_timeout: std::time::Duration,
) -> super::super::server::RegistryServer {
    let config = crate::monad_outbox::MonadOutboxReconcileConfig {
        expected_chain_id: 10143,
        rpc_timeout,
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
            min_value_wei,
            b"MONT".to_vec(),
        ),
        evm_rpc: None,
        bitcoin_proxy: None,
        solana_proxy: None,
        spa_dir: None,
        event_bus: fixture.registry.event_bus().clone(),
    }
}
pub(crate) async fn public_p_signature(
    root: &std::path::Path,
    digest: [u8; 32],
    point: &str,
) -> Vec<u8> {
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
async fn message_for_a_recipient_this_relay_cannot_deliver_to_is_dead_without_any_payment() {
    // The sender's relay: both accounts are published here, but the recipient's own entry says
    // its mailbox is on a different relay.
    undeliverable(NativeDirectoryFixture::homed(0, |_| true).await).await;
    // The recipient's relay, where the recipient has never published.
    undeliverable(NativeDirectoryFixture::homed(1, |index| index == 0).await).await;
}
async fn undeliverable(fixture: NativeDirectoryFixture) {
    assert_eq!(
        final_answer(fixture, false).await,
        (200, "undeliverable".to_owned())
    );
}
#[tokio::test]
async fn message_from_a_sender_with_no_entry_here_gets_a_final_explanatory_answer() {
    let fixture = NativeDirectoryFixture::homed(1, |index| index == 1).await;
    assert_eq!(
        final_answer(fixture, false).await,
        (200, "sender_unpublished".to_owned())
    );
}
#[tokio::test]
async fn a_busy_directory_is_a_retryable_answer_never_a_final_one() {
    // Both accounts are fine; the relay itself cannot look them up right now.
    let fixture = NativeDirectoryFixture::homed(1, |_| true).await;
    assert_eq!(
        final_answer(fixture, true).await,
        (503, "canonical_mailbox_unavailable".to_owned())
    );
}
/// Submit the genuine request and return the status with the dead reason or error code. Checks
/// that nothing was retained and the chain was never contacted.
async fn final_answer(fixture: NativeDirectoryFixture, busy: bool) -> (u16, String) {
    let request = genuine_fixture();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = calls.clone();
    let rpc = axum::Router::new().route(
        "/",
        axum::routing::post(move |Json(_): Json<serde_json::Value>| {
            observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Json(serde_json::json!({"jsonrpc":"2.0","id":1,"result":null})) }
        }),
    );
    let (rpc_url, rpc_stop, rpc_task) = serve_http(rpc).await;
    let (url, http_stop, http_task) = serve_http(
        server(&fixture, &rpc_url).into_router_with_directory(Some(fixture.directory.clone())),
    )
    .await;
    let account = &fixture.accounts[1];
    let held: Vec<_> = (0..if busy { 8 } else { 0 })
        .map(|_| {
            fixture
                .directory
                .reserve(&account.network, &account.subject)
                .unwrap()
        })
        .collect();
    let client = reqwest::Client::new();
    if busy {
        // Mailbox authentication under the same condition is "retry", not "who are you".
        let recipient = crate::monad_stamp_stealth::recipient_address_from_public_key(
            &hex::decode(&account.subject).unwrap(),
        )
        .unwrap()
        .to_hex();
        let challenge = client
            .post(format!(
                "{url}/message/monad/cbor/auth/{recipient}?resource=inbox&since=0&limit=50&max_bytes=8388608"
            ))
            .header("x-frank-mailbox-subject", &account.subject)
            .send()
            .await
            .unwrap();
        assert_eq!(challenge.status().as_u16(), 503);
    }
    let response = client
        .put(format!("{url}/message/monad/cbor"))
        .header("content-type", request.content_type())
        .body(request.body().to_vec())
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body: serde_json::Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    drop(held);
    http_stop.send(()).unwrap();
    http_task.await.unwrap();
    rpc_stop.send(()).unwrap();
    rpc_task.await.unwrap();
    assert_eq!(body["version"], 1);
    if status == 200 {
        assert_eq!(body["phase"], "dead");
        // The identity is the same echo a delivered submission would carry.
        assert_eq!(
            body["identity"]["submission_identity"],
            hex::encode(request.submission_identity())
        );
        assert_eq!(
            body["identity"]["sender_t1"],
            fixture.accounts[0].revision_zero.as_str()
        );
        assert_eq!(
            body["identity"]["recipient_t1"],
            fixture.accounts[1].revision_zero.as_str()
        );
        assert_eq!(body["identity"]["payload_hash"].as_str().unwrap().len(), 64);
    }
    // Nothing was retained and the chain was never contacted.
    assert!(fixture
        .registry
        .canonical_dm()
        .find_request(&request)
        .unwrap()
        .is_none());
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    fixture.stop().await;
    let detail = if status == 200 {
        &body["reason"]
    } else {
        &body["error"]
    };
    (status, detail.as_str().unwrap().to_owned())
}

#[tokio::test]
async fn zero_stamp_message_is_admitted_and_delivered_immediately() {
    let fixture = NativeDirectoryFixture::new().await;
    let genuine = genuine_fixture();
    let mut ctx = frank_cbor::default_context();
    ctx.reader_version = 2;
    ctx.supported_schemas.push(frank_cbor::SupportedSchema {
        type_id: 1,
        schema_version: 2,
    });
    let frank_cbor::ValidationResult::Parsed(parsed) =
        frank_cbor::validate_frame(genuine.delivery(), &ctx).unwrap()
    else {
        panic!("delivery must parse");
    };
    let frank_cbor::CborValue::Map(mut entries) = parsed.payload else {
        panic!("payload must be a map");
    };
    for (k, v) in &mut entries {
        if *k == 4 {
            *v = frank_cbor::CborValue::Array(vec![]);
        }
    }
    let zero_delivery = frank_cbor::encode_frame(
        frank_cbor::EnvelopeFields {
            type_id: 1,
            schema_version: 2,
            min_reader_version: 1,
        },
        frank_cbor::FramePayload::Value(&frank_cbor::CborValue::Map(entries)),
    )
    .unwrap();
    let boundary = "frank-zero-stamp-test-777";
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"delivery\"\r\nContent-Type: application/vnd.frank.cbor\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&zero_delivery);
    body.extend_from_slice(
        format!(
            "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"context\"\r\nContent-Type: application/cbor\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(genuine.context());
    body.extend_from_slice(
        format!(
            "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"transactions\"\r\nContent-Type: application/cbor\r\n\r\n"
        )
        .as_bytes(),
    );
    body.push(0x80);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let request = ExactRequest::parse(
        body,
        format!("multipart/form-data; boundary={boundary}").into(),
    )
    .unwrap();
    assert_eq!(request.transaction_count(), 0);

    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = calls.clone();
    let rpc = axum::Router::new().route(
        "/",
        axum::routing::post(move |Json(_): Json<serde_json::Value>| {
            observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Json(serde_json::json!({"jsonrpc":"2.0","id":1,"result":null})) }
        }),
    );
    let (rpc_url, rpc_stop, rpc_task) = serve_http(rpc).await;
    let (url, http_stop, http_task) = serve_http(
        server(&fixture, &rpc_url).into_router_with_directory(Some(fixture.directory.clone())),
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
    let status = response.status().as_u16();
    let resp_body: serde_json::Value =
        serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();

    http_stop.send(()).unwrap();
    http_task.await.unwrap();
    rpc_stop.send(()).unwrap();
    rpc_task.await.unwrap();

    assert_eq!(status, 200, "resp: {:?}", resp_body);
    assert_eq!(resp_body["version"], 1);
    assert_eq!(resp_body["phase"], "delivered");

    // Zero EVM RPC transactions were made!
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);

    // Verify it is in the recipient inbox
    let recipient_account = &fixture.accounts[1];
    let recipient = crate::monad_stamp_stealth::recipient_address_from_public_key(
        &hex::decode(&recipient_account.subject).unwrap(),
    )
    .unwrap();
    let inbox = fixture
        .registry
        .canonical_dm()
        .inbox(recipient, 0, None, 10)
        .unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(
        inbox[0].policy.payload_hash,
        request_principals(&request, "monad-testnet")
            .unwrap()
            .payload_hash
    );

    fixture.stop().await;
}

#[path = "monad_message_cbor_delivery_tests.rs"]
mod delivery;

// Public child0/1 derivation + independent offline funding keys; no chain authority.
const PREFIX_T_BODY_HEX: &str = "2d2d6672616e6b2d7072656669782d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d2264656c6976657279220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f766e642e6672616e6b2e63626f720d0a0d0a46524e4b0100000912a400010101020103590907a5006d6d6f6e61642d746573746e657401a20001015821031932bd4a3b404c1477cab87652d75ce112d24e8b1698d8cf5b1834cfc8d33fbb025907a246524e4b0100000799a40005010202020359078ea8006d6d6f6e61642d746573746e657401a20001015821032de89548d6742189952342246af8e438ce63c8ad25a857690e353f3331d6c53702a20001015821036253871fdcfbb0497776db33754caaafad98c1b4b0ae4945ddf8660e27687a1a03010459069da6000201010219ff0003582043bed8daec2f39d9f1af1f292b277a5270772b80e8fb9eef3a99b48689039b6904582102efe3593d7c4ed3419a7055df81219a5d88eea56da4931dd5c2131f22f98c2fee05590649ad4f6a4781a00434ce5a2c2f9b7548a27a614c0f2ee0c482e118a60d1e28971a7fbe3a25c4b7733861ebc9771e4e0950fae81c8af7825b5d8b803440549af6235567b090f7f59dbfd9b6896bca74ab25933f6f32e65b12f5d56facd7f2e591818ebfbd2476c02102b9dfc69b9382a34aca902cabec67dcae8c972db19a00d375c608b8331281d6fea27d75ffd92ff541b5c15878f029034e65501821c82d138618e54857c6b0ce2c14307007a97c561c88a3f7f86b82a778b3b76a9be4a87cd18b1a83eda8d1561aa042f5858f32de17201c32e419c7f8a9c0d5c1dd4979a1817718d03876d5e5fb14e5bba867e9b49cb762d3874a90829786d6e9224c964ba0e52bbc6d241a54825a6120be0a968d2e07d4a5470455b9bd6762055c1f6e016da64e7f834b41b0116151299533a0884aa2f115ce057ea5c408ecd397bdd0219c6718565be9c549d41fd3f94b594947ca0cb43317f9457936bfa1143f9825de08eb63fbdd061c8cd9b458989f838de4af3c724aae1fb9024091b24d3fa17b34f3de321faeab4ae102347d169a0349eeaae665487f51c956adba2a4d8cc2f971651cfa8138a094cedf486d427821282205582781ca1e5d2aaf0bfbee87be13077ea59e0790d89d457889a3f2412acd8bfb3c55f373e4b7745309378f82f9bcb45d8660419f0af46fc4cff76463556787579b24a3b1d9c9605390e5d0f22fd5a95b9022721f86dbd4a7de002218469ae810ae5f1553f4d314f508e50fdbc4e863a7245bca454e75a80c5660101b30348f397de2721cd0ff9886f32d3280d2a79cac461e65692068d3fe6b7f3515764b00e2634a5f58b4064ac5b1246fe51b4f44cf5f157972bae3e7f420506e2bad634ad1d9e55997d469ca26043abe25bfbe950fedb9b42111ddc9b27cf4760d624b7935f653dae159977cb3939226ab29ac8ba8153f1ab6fc940695843d8cc7f80a1495f6f3db8708f4ea5030429936e9affd7415aa6f521a303e863e0e80247efae6e9053388439af8b5f8f205a1876e94b58581e872886211f4021034d75651cc23494fcec95d7b71f4fd5817643a65f14518c939490e113c35285ee1057cd9d5c59b4c8f000a9571b3f2a8bbb192eb0b888cdd7ef8d01fd267dfcd1be487b87535fe7096a8a91cd5e3e8851cfa94a74c322c51d86587e566a4dcf7f43477b4f4fb60d820832830b1c41710c6cfa2bf92aec394185aa80875832f7e8d8847b52518a9998d7f00ca73de2645d4d0d306ad04da2e6790645637b0314e8d7e6f752654b312458c265bb60bdc43e0b9f964df3edf164f85ac6e09a4326645fdee05eac0151ff1ea8c8cfcca5792c3431b5c386d3b41facd34edc90d7c6d5e5d9ce8541021811c620cbb08523bea8d367f36dd4c0614800de5577a2b2278fd473405b8d5e05c38b431a0d6b7c19251c4f4668908dd43900796f7acc4a299b655133100b859193e937d03db3deaa5c0a9efcaf2373a224e890c714ce04d40454d25cec2a24a30c58ee79bdf11ea590d0082b0071cbe66055f3850823183f54bd3cdb7fc319923963a8a9a396985b3c7cd1dd81aef94832aa795ea6a0bad6f60b89d0e2dae21d221d4ca2811dacb28569b2755e2a870c6649581b1eee2ef7389cb207c331a2b7e61d6b9dcd9a8cb4cb9301d8a9902e11df90b63d9137afbb2dfbd4c17958c5dcc79d519fe2a5a99c2391115e41c42642c8669e228f42d1b84749e13d370d5273a5079bbabc6c62cbca3973d1ae2bb1d2786f2de544fb62253033d203c46f2ac90e9f9b1f7bb2d6be01e2b2d53d177a1ebfd6382ae0819a4609922eb6f743450a1db5d98453b132441a73a3e4729d150a2136e938660a8558f72ceaf7bb55836d0ebc8012e90d132550ab99a27f5cbaae8efe5794c1105e9d3cd7ba0d1df5a04f774f0a02b54e2e815203ef154b6df9143c9b86eddd21b32f6ebee88008c1bd9493b8a141cdb3e09e4f801aef36c93432a4c11415b7dc67ac684b4fa46160af80a72a83950d77c1e37a6711c53e78e879775cf2ca6013337978d026fdea24f1881fc7e2eac8e1e4249bcc068e64610aa706fee619372f781d8903f2cb5f413941b9ecba4b05c2d7ac78fc8d04a10f5133c60e4499a7834e8bda518b64f1b6c1d2c6eada6ae5e08da0feed9419f701eaba13c5bbb95374f663ebf9c5d8dcbf42b734bb0776d8580b6fcf420d01c51061a3bc81cf5e8e364bb842cd94e60e5735a13aa49ab9b3149f9d422129dca13a546e4254a4923e92b5ff905582103ff218b7b9816efd78fda57849ebb9c81948df3b625011ff0ab7d6621fdcbcb03065821021ed2dceddc83589ac5335ceeb3b8b114329e49bbad5220986440be03e341341c075840b54790a36571925da0b9afcff467327e49c9cf856afcbb04b567b6e6d5673a859c5001e8a50bc7610c533dc5e87637af173f0aca86dd9e1d58f206f92b6cd1920358209f688f51d6a798d62f4b14a8b1958b14d22916ca0cb8108b91b017f238f7f2d20482a5000001582080ae3d65a61d9ed00144129b5fe5a8b1607bafae56d594c73ebc257e466d8094025820000000000000000000000000000000000000000000000000000000000000000103542adf2cb0d2a8f42fd83e2c32912654a8ac76a4550458209d15a0c9d45c50955cc400ff9e8f42bf59caa0514058abad8fe9a678afb0f057a50001015820bda8a93f8f2e9142bf9dff66ba8cef55fab7b21fe00675435eeb7f6f31d8ae440258200000000000000000000000000000000000000000000000000000000000000001035448b7a08b057a00653c3323ce425884549f6d3559045820a11ca14f45b4f73c1ed93e7cc4662762e705dc2f9b007fe68c48d830bda4ced00d0a2d2d6672616e6b2d7072656669782d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d22636f6e74657874220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f63626f720d0a0d0ab000781a6672616e6b2f646d2d63727970746f2d636f6e746578742f7631016d6d6f6e61642d746573746e657402a20001015821032de89548d6742189952342246af8e438ce63c8ad25a857690e353f3331d6c53703a20001015821036253871fdcfbb0497776db33754caaafad98c1b4b0ae4945ddf8660e27687a1a045820ed8493488028b1eed0bbd56edf022a19c6d13ee3e586792115012f14c82d97bb0558209b5957605976ee5d06728184df1d4174abacc4980fa145545ea07dc53e9640e506a2000101582102c05066c3239fc712592940a09c9272ea9b0373bbf548008e17a20c3d2a0161c207a2000101582103e84266f9de81abb5455f18083f781b09367263e3992bf51a9ea571f28619b81b08a20001015821031932bd4a3b404c1477cab87652d75ce112d24e8b1698d8cf5b1834cfc8d33fbb09582103ff218b7b9816efd78fda57849ebb9c81948df3b625011ff0ab7d6621fdcbcb030a5821021ed2dceddc83589ac5335ceeb3b8b114329e49bbad5220986440be03e341341c0b5840b54790a36571925da0b9afcff467327e49c9cf856afcbb04b567b6e6d5673a859c5001e8a50bc7610c533dc5e87637af173f0aca86dd9e1d58f206f92b6cd1920c010d050e020f020d0a2d2d6672616e6b2d7072656669782d3737370d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d227472616e73616374696f6e73220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f63626f720d0a0d0a82586702f86482279f800102825208942adf2cb0d2a8f42fd83e2c32912654a8ac76a4550180c001a019e26823936e9d556db4728e30c8c0a1f90b4e9479cfbd33759f529b4e450fe7a05383c03f1877695b615dd9401e6472ad5184bf919f361b7cb33e0ffee6060b15586702f86482279f8001028252089448b7a08b057a00653c3323ce425884549f6d35590180c080a09a6b6c28342a86bb7adeb4501829c203cd37f8e2f6d45ba5796840f4f5a044c9a0440cfe82dfb053cc50c112897a771e66bf29765a895956acba6d3886a3c11b1d0d0a2d2d6672616e6b2d7072656669782d3737372d2d0d0a";
fn prefix_fixture() -> ExactRequest {
    let request = ExactRequest::parse(
        hex::decode(PREFIX_T_BODY_HEX).unwrap(),
        "multipart/form-data; boundary=frank-prefix-777".into(),
    )
    .unwrap();
    assert_eq!(
        hex::encode(request.submission_identity()),
        "799decf496775f0c9b04fc9c1246d5844233441a63404a92ed2382abe41a46a5"
    );
    request
}

async fn private_headers(
    client: &reqwest::Client,
    url: &str,
    root: &std::path::Path,
    point: &str,
    binding: &crate::monad_mailbox::MailboxRequestBinding,
) -> reqwest::header::HeaderMap {
    use crate::monad_mailbox::{MailboxChallenge, MailboxResource};
    use bitcoinsuite_core::Sha256;
    let resource = match binding.resource {
        MailboxResource::Inbox => "inbox",
        MailboxResource::Recovery => "recovery",
        MailboxResource::RecoveryAck => "recovery_ack",
        MailboxResource::Mailbox => "mailbox",
        MailboxResource::MailboxStream => "mailbox_ws",
    };
    let mut query = format!(
        "resource={resource}&since={}&limit={}&max_bytes={}",
        binding.since, binding.limit, binding.max_bytes
    );
    if let Some(hash) = binding.recovery_payload_hash {
        query.push_str(&format!("&recovery_payload_hash={}", hex::encode(hash)));
    }
    if let Some(obligation) = binding.recovery_obligation_id {
        query.push_str(&format!(
            "&recovery_obligation_id={}",
            hex::encode(obligation)
        ));
    }
    let response = client
        .post(format!(
            "{url}/message/monad/cbor/auth/{}?{query}",
            binding.recipient.to_hex()
        ))
        .header("x-frank-mailbox-subject", point)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let challenge: serde_json::Value =
        serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    assert_eq!(challenge["network_tag"], "4d4f4e54");
    let token = MailboxChallenge {
        epoch: hash_hex(challenge["epoch"].as_str().unwrap()).unwrap(),
        nonce: hash_hex(challenge["nonce"].as_str().unwrap()).unwrap(),
        token: hash_hex(challenge["token"].as_str().unwrap()).unwrap(),
        expires_at_ms: challenge["expires_at_ms"].as_i64().unwrap(),
    };
    let digest = Sha256::digest(
        super::super::monad_message::mailbox_auth_preimage(token, binding, b"MONT").into(),
    );
    let signature = public_p_signature(root, digest.as_slice().try_into().unwrap(), point).await;
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("x-frank-mailbox-subject", point.parse().unwrap());
    for (name, field) in [
        ("x-frank-mailbox-epoch", "epoch"),
        ("x-frank-mailbox-nonce", "nonce"),
        ("x-frank-mailbox-token", "token"),
    ] {
        headers.insert(name, challenge[field].as_str().unwrap().parse().unwrap());
    }
    headers.insert(
        "x-frank-mailbox-expires-at-ms",
        token.expires_at_ms.to_string().parse().unwrap(),
    );
    headers.insert(
        "x-frank-mailbox-signature",
        hex::encode(signature).parse().unwrap(),
    );
    headers
}

#[tokio::test]
async fn cbor_challenge_succeeds_and_read_returns_unavailable_when_read_permits_exhausted() {
    let fixture = NativeDirectoryFixture::new().await;
    let _ = fixture
        .registry
        .canonical_dm()
        .attach_directory(fixture.directory.clone());
    let mut config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
    config.expected_chain_id = 10143;
    config.private_read_concurrency = 1;
    let runtime = crate::monad_mailbox::MonadMailboxRuntime::enabled(
        crate::monad_http::HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
        Arc::new(config),
        10143,
        b"MONT".to_vec(),
    );
    let server = super::super::server::RegistryServer {
        registry: fixture.registry.clone(),
        peers: Arc::new(crate::p2p::peers::Peers::new(
            "http://127.0.0.1:1".into(),
            vec![],
        )),
        pop_gate: Arc::new(crate::http::pop_protection::PopGate::from_conf_if_enabled(
            &crate::test_instance::placeholder_pop_conf(),
        )),
        curated_defaults: Arc::new(vec![]),
        monad_mailbox: runtime.clone(),
        evm_rpc: None,
        bitcoin_proxy: None,
        solana_proxy: None,
        spa_dir: None,
        event_bus: fixture.registry.event_bus().clone(),
    };
    let account = &fixture.accounts[1];
    let recipient_hex = crate::monad_stamp_stealth::recipient_address_from_public_key(
        &hex::decode(&account.subject).unwrap(),
    )
    .unwrap()
    .to_hex();
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-frank-mailbox-subject",
        axum::http::HeaderValue::from_str(&account.subject).unwrap(),
    );

    let held_permit = runtime
        .as_enabled()
        .unwrap()
        .try_acquire_private_read()
        .unwrap();

    let query = PrivateQuery {
        resource: Some("mailbox".into()),
        since: Some(0),
        cursor: None,
        limit: Some(10),
        max_bytes: Some(1024),
        recovery_payload_hash: None,
        recovery_obligation_id: None,
    };
    let response = handle_challenge(
        axum::extract::Path(recipient_hex.clone()),
        axum::extract::Query(query.clone()),
        Extension(server.clone()),
        headers.clone(),
    )
    .await;
    assert!(
        response.is_ok(),
        "handle_challenge should not be blocked by private read permits: {:?}",
        response.err()
    );

    let mut mailbox_query = query;
    mailbox_query.resource = None;
    let read_err = handle_mailbox(
        axum::extract::Path(recipient_hex),
        axum::extract::Query(mailbox_query),
        Extension(server),
        headers,
    )
    .await
    .unwrap_err();
    assert!(
        matches!(read_err, CanonicalError::Unavailable),
        "permit exhaustion should return Unavailable (503), got {:?}",
        read_err
    );
    let resp = read_err.into_response();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

    drop(held_permit);
    fixture.stop().await;
}

#[test]
fn cbor_capacity_error_includes_retry_after_header() {
    let err = CanonicalError::Capacity;
    let resp = err.into_response();
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        resp.headers().get(axum::http::header::RETRY_AFTER).unwrap(),
        "60"
    );
}

#[path = "monad_message_cbor_joined_tests.rs"]
mod joined;

// #826 payment-reuse fixture, derived by tests/support/canonical_dm_plain_transfer_fixtures.cjs:
// the genuine request with one ciphertext byte changed. Same ephemeral key, shared point,
// proof, destination and signed payment; different sealed body, T3 and frame commitment.
const REPLAY_T_BODY_HEX: &str = "2d2d6672616e6b2d7265706c61792d3832360d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d2264656c6976657279220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f766e642e6672616e6b2e63626f720d0a0d0a46524e4b0100000890a400010101020103590885a5006d6d6f6e61642d746573746e657401a20001015821031932bd4a3b404c1477cab87652d75ce112d24e8b1698d8cf5b1834cfc8d33fbb025907a246524e4b0100000799a40005010202020359078ea8006d6d6f6e61642d746573746e657401a20001015821032de89548d6742189952342246af8e438ce63c8ad25a857690e353f3331d6c53702a20001015821036253871fdcfbb0497776db33754caaafad98c1b4b0ae4945ddf8660e27687a1a03010459069da6000201010219ff0003582043bed8daec2f39d9f1af1f292b277a5270772b80e8fb9eef3a99b48689039b6904582102efe3593d7c4ed3419a7055df81219a5d88eea56da4931dd5c2131f22f98c2fee05590649ad4f6a4781a00434ce5a2c2f9b7548a27a614c0f2ee0c482e118a60d1e28971a7fbe3a25c4b7733861ebc9771e4e0950fae81c8af7825b5d8b803440549af6235567b090f7f59dbfd9b6896bca74ab25933f6f32e65b12f5d56facd7f2e591818ebfbd2476c02102b9dfc69b9382a34aca902cabec67dcae8c972db19a00d375c608b8331281d6fea27d75ffd92ff541b5c15878f029034e65501821c82d138618e54857c6b0ce2c14307007a97c561c88a3f7f86b82a778b3b76a9be4a87cd18b1a83eda8d1561aa042f5858f32de17201c32e419c7f8a9c0d5c1dd4979a1817718d03876d5e5fb14e5bba867e9b49cb762d3874a90829786d6e9224c964ba0e52bbc6d241a54825a6120be0a968d2e07d4a5470455b9bd6762055c1f6e016da64e7f834b41b0116151299533a0884aa2f115ce057ea5c408ecd397bdd0219c6718565be9c549d41fd3f94b594947ca0cb43317f9457936bfa1143f9825de08eb63fbdd061c8cd9b458989f838de4af3c724aae1fb9024091b24d3fa17b34f3de321faeab4ae102347d169a0349eeaae665487f51c956adba2a4d8cc2f971651cfa8138a094cedf486d427821282205582781ca1e5d2aaf0bfbee87be13077ea59e0790d89d457889a3f2412acd8bfb3c55f373e4b7745309378f82f9bcb45d8660419f0af46fc4cff76463556787579b24a3b1d9c9605390e5d0f22fd5a95b9022721f86dbd4a7de002218469ae810ae5f1553f4d314f508e50fdbc4e863a7245bca454e75a80c5660101b30348f397de2721cd0ff9886f32d3280d2a79cac461e65692068d3fe6b7f3515764b00e2634a5f58b4064ac5b1246fe51b4f44cf5f157972bae3e7f420506e2bad634ad1d9e55997d469ca26043abe25bfbe950fedb9b42111ddc9b27cf4760d624b7935f653dae159977cb3939226ab29ac8ba8153f1ab6fc940695843d8cc7f80a1495f6f3db8708f4ea5030429936e9affd7415aa6f521a303e863e0e80247efae6e9053388439af8b5f8f205a1876e94b58581e872886211f4021034d75651cc23494fcec95d7b71f4fd5817643a65f14518c939490e113c35285ee1057cd9d5c59b4c8f000a9571b3f2a8bbb192eb0b888cdd7ef8d01fd267dfcd1be487b87535fe7096a8a91cd5e3e8851cfa94a74c322c51d86587e566a4dcf7f43477b4f4fb60d820832830b1c41710c6cfa2bf92aec394185aa80875832f7e8d8847b52518a9998d7f00ca73de2645d4d0d306ad04da2e6790645637b0314e8d7e6f752654b312458c265bb60bdc43e0b9f964df3edf164f85ac6e09a4326645fdee05eac0151ff1ea8c8cfcca5792c3431b5c386d3b41facd34edc90d7c6d5e5d9ce8541021811c620cbb08523bea8d367f36dd4c0614800de5577a2b2278fd473405b8d5e05c38b431a0d6b7c19251c4f4668908dd43900796f7acc4a299b655133100b859193e937d03db3deaa5c0a9efcaf2373a224e890c714ce04d40454d25cec2a24a30c58ee79bdf11ea590d0082b0071cbe66055f3850823183f54bd3cdb7fc319923963a8a9a396985b3c7cd1dd81aef94832aa795ea6a0bad6f60b89d0e2dae21d221d4ca2811dacb28569b2755e2a870c6649581b1eee2ef7389cb207c331a2b7e61d6b9dcd9a8cb4cb9301d8a9902e11df90b63d9137afbb2dfbd4c17958c5dcc79d519fe2a5a99c2391115e41c42642c8669e228f42d1b84749e13d370d5273a5079bbabc6c62cbca3973d1ae2bb1d2786f2de544fb62253033d203c46f2ac90e9f9b1f7bb2d6be01e2b2d53d177a1ebfd6382ae0819a4609922eb6f743450a1db5d98453b132441a73a3e4729d150a2136e938660a8558f72ceaf7bb55836d0ebc8012e90d132550ab99a27f5cbaae8efe5794c1105e9d3cd7ba0d1df5a04f774f0a02b54e2e815203ef154b6df9143c9b86eddd21b32f6ebee88008c1bd9493b8a141cdb3e09e4f801aef36c93432a4c11415b7dc67ac684b4fa46160af80a72a83950d77c1e37a6711c53e78e879775cf2ca6013337978d026fdea24f1881fc7e2eac8e1e4249bcc068e64610aa706fee619372f781d8903f2cb5f413941b9ecba4b05c2d7ac78fc8d04a10f5133c60e4499a7834e8bda518b64f1b6c1d2c6eada6ae5e08da0feed9419f701eaba13c5bbb95374f663ebf9c5d8dcbf42b734bb0776d8580b6fcf420d01c51061a3bc81cf5e8e364bb842cd94e60e5735a13aa49ab9b3149f9d422129dca13a546e4254a4923e92b5ff805582103ff218b7b9816efd78fda57849ebb9c81948df3b625011ff0ab7d6621fdcbcb03065821021ed2dceddc83589ac5335ceeb3b8b114329e49bbad5220986440be03e341341c075840b54790a36571925da0b9afcff467327e49c9cf856afcbb04b567b6e6d5673a859c5001e8a50bc7610c533dc5e87637af173f0aca86dd9e1d58f206f92b6cd19203582064f01bedb2d650c0d9a688cdce3fc2e2281ebc0b930abe6e6e21bc1a7d20bbf50481a5000001582080ae3d65a61d9ed00144129b5fe5a8b1607bafae56d594c73ebc257e466d8094025820000000000000000000000000000000000000000000000000000000000000000103542adf2cb0d2a8f42fd83e2c32912654a8ac76a4550458205bb114162dd332146c07ff4d8c55cb969c436f9c668d793cbe4d08ad9d88715e0d0a2d2d6672616e6b2d7265706c61792d3832360d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d22636f6e74657874220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f63626f720d0a0d0ab000781a6672616e6b2f646d2d63727970746f2d636f6e746578742f7631016d6d6f6e61642d746573746e657402a20001015821032de89548d6742189952342246af8e438ce63c8ad25a857690e353f3331d6c53703a20001015821036253871fdcfbb0497776db33754caaafad98c1b4b0ae4945ddf8660e27687a1a045820ed8493488028b1eed0bbd56edf022a19c6d13ee3e586792115012f14c82d97bb0558209b5957605976ee5d06728184df1d4174abacc4980fa145545ea07dc53e9640e506a2000101582102c05066c3239fc712592940a09c9272ea9b0373bbf548008e17a20c3d2a0161c207a2000101582103e84266f9de81abb5455f18083f781b09367263e3992bf51a9ea571f28619b81b08a20001015821031932bd4a3b404c1477cab87652d75ce112d24e8b1698d8cf5b1834cfc8d33fbb09582103ff218b7b9816efd78fda57849ebb9c81948df3b625011ff0ab7d6621fdcbcb030a5821021ed2dceddc83589ac5335ceeb3b8b114329e49bbad5220986440be03e341341c0b5840b54790a36571925da0b9afcff467327e49c9cf856afcbb04b567b6e6d5673a859c5001e8a50bc7610c533dc5e87637af173f0aca86dd9e1d58f206f92b6cd1920c010d050e020f020d0a2d2d6672616e6b2d7265706c61792d3832360d0a436f6e74656e742d446973706f736974696f6e3a20666f726d2d646174613b206e616d653d227472616e73616374696f6e73220d0a436f6e74656e742d547970653a206170706c69636174696f6e2f63626f720d0a0d0a81586702f86482279f800102825208942adf2cb0d2a8f42fd83e2c32912654a8ac76a4550180c001a019e26823936e9d556db4728e30c8c0a1f90b4e9479cfbd33759f529b4e450fe7a05383c03f1877695b615dd9401e6472ad5184bf919f361b7cb33e0ffee6060b150d0a2d2d6672616e6b2d7265706c61792d3832362d2d0d0a";
fn replay_fixture() -> ExactRequest {
    ExactRequest::parse(
        hex::decode(REPLAY_T_BODY_HEX).unwrap(),
        "multipart/form-data; boundary=frank-replay-826".into(),
    )
    .unwrap()
}

#[test]
fn replay_fixture_reuses_the_exact_signed_payment_for_another_sealed_body() {
    let (genuine, replay) = (genuine_fixture(), replay_fixture());
    assert!(genuine.raw_transactions().eq(replay.raw_transactions()));
    assert_eq!(genuine.context(), replay.context());
    assert_ne!(genuine.delivery(), replay.delivery());
    assert_ne!(genuine.submission_identity(), replay.submission_identity());
}

/// Every embedded canonical fixture pays with a plain value transfer: no calldata at all,
/// so nothing on chain marks the payment as a Frank message stamp.
#[test]
fn every_canonical_fixture_payment_is_a_plain_transfer_with_empty_input() {
    let requests = [
        fixture(),
        genuine_fixture(),
        prefix_fixture(),
        replay_fixture(),
    ];
    let mut members = 0;
    for request in &requests {
        for raw in request.raw_transactions() {
            let signed = crate::monad_evm_tx::decode_signed_transaction(raw).unwrap();
            assert!(signed.input.is_empty());
            assert!(!raw.windows(4).any(|window| window == b"POND"));
            members += 1;
        }
    }
    assert_eq!(members, 1 + 1 + 2 + 1);
}

async fn admitted_input(
    fixture: &NativeDirectoryFixture,
    request: &ExactRequest,
) -> Result<crate::monad_outbox::financial::CanonicalPaymentInput> {
    let principals = request_principals(request, "monad-testnet").unwrap();
    let sender = current(
        fixture.registry.canonical_dm(),
        "monad-testnet",
        &principals.sender,
    )
    .await
    .unwrap();
    let recipient = current(
        fixture.registry.canonical_dm(),
        "monad-testnet",
        &principals.recipient,
    )
    .await
    .unwrap();
    crate::monad_outbox::financial::validate_canonical_payment_set(
        request.clone(),
        &sender,
        &recipient,
        None,
        "monad-testnet",
        10143,
        1,
    )
}

/// Calldata is refused on the canonical path, including the retired `POND` version-2
/// commitment that the legacy protobuf path still requires.
#[tokio::test]
async fn canonical_admission_rejects_any_calldata_on_a_signed_member() {
    use bitcoinsuite_core::ecc::Ecc;
    let fixture = NativeDirectoryFixture::new().await;
    let genuine = genuine_fixture();
    assert!(admitted_input(&fixture, &genuine).await.is_ok());
    let raw = genuine.raw_transactions().next().unwrap().to_vec();
    let plain = crate::monad_evm_tx::decode_signed_transaction(&raw).unwrap();
    let frank_cbor::ValidationResult::Parsed(frame) =
        frank_cbor::validate_frame(genuine.delivery(), &frank_cbor::default_context()).unwrap()
    else {
        panic!("genuine delivery frame");
    };
    let Some(frank_cbor::TypedPayload::DirectMessage {
        payload_digest,
        payments,
        ..
    }) = frame.typed.as_deref()
    else {
        panic!("genuine direct message");
    };
    let mut pond = b"POND".to_vec();
    pond.push(crate::monad_stamp_verify::COMMITMENT_VERSION_TAG);
    pond.extend_from_slice(&frank_cbor::payment_commitment(payload_digest, 0));
    let secret = bitcoinsuite_ecc_secp256k1::EccSecp256k1::default()
        .seckey_from_array({
            let mut one = [0; 32];
            one[31] = 1;
            one
        })
        .unwrap();
    // The empty-input control proves the hand-built request is otherwise admissible.
    for input in [Vec::new(), pond, vec![0]] {
        let (tagged, _) = crate::monad_evm_tx::test_support::signed_eip1559_tx(
            &secret,
            10143,
            plain.nonce,
            plain.destination.unwrap(),
            plain.value_wei,
            &input,
        );
        let signed = crate::monad_evm_tx::decode_signed_transaction(&tagged).unwrap();
        assert_eq!(signed.sender, plain.sender);
        assert_eq!(signed.input, input);
        // Same frame, with only the listed transaction hash following the tagged member.
        let mut delivery = genuine.delivery().to_vec();
        let listed = payments[0].transaction_id.as_slice();
        let at = delivery
            .windows(32)
            .position(|window| window == listed)
            .unwrap();
        delivery[at..at + 32].copy_from_slice(&signed.tx_hash.0);
        let boundary = "frank-tagged-826";
        let transactions =
            encode_canonical(&CborValue::Array(vec![CborValue::Bytes(tagged)])).unwrap();
        let mut body = Vec::new();
        for (name, media, bytes) in [
            (
                "delivery",
                "application/vnd.frank.cbor",
                delivery.as_slice(),
            ),
            ("context", "application/cbor", genuine.context()),
            ("transactions", "application/cbor", transactions.as_slice()),
        ] {
            body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\nContent-Type: {media}\r\n\r\n").as_bytes());
            body.extend_from_slice(bytes);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        let request =
            ExactRequest::parse(body, format!("multipart/form-data; boundary={boundary}")).unwrap();
        assert_eq!(
            admitted_input(&fixture, &request).await.err(),
            (!input.is_empty()).then_some(CanonicalError::Invalid)
        );
    }
    fixture.stop().await;
}

/// One signed payment pays for one message. With empty calldata nothing on chain names the
/// message, so a sender who reuses the ephemeral key (or anyone who has seen the shared point
/// and proof) can present the same confirmed transaction under a second sealed body. The
/// durable used-payment index refuses that on new admission and after reopening the store,
/// while exact retries stay idempotent.
#[tokio::test]
async fn one_signed_payment_cannot_be_claimed_for_a_second_message() {
    use crate::monad_http::Hash32;
    use crate::store::monad_dm_cbor::Phase;
    use futures::FutureExt;
    let fixture = NativeDirectoryFixture::new().await;
    let (genuine, replay) = (genuine_fixture(), replay_fixture());
    // The node sees only broadcasts: one for each accepted submit of the genuine message.
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = calls.clone();
    let rpc = axum::Router::new().route(
        "/",
        axum::routing::post(move |Json(query): Json<serde_json::Value>| {
            let calls = observed.clone();
            async move {
                assert_eq!(query["method"], "eth_sendRawTransaction");
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Json(serde_json::json!({"jsonrpc":"2.0","id":query["id"],"result":Hash32([7;32]).to_hex()}))
            }
        }),
    );
    let (rpc_url, rpc_stop, rpc_task) = serve_http(rpc).await;
    let put = |url: String, request: ExactRequest| async move {
        let response = reqwest::Client::new()
            .put(format!("{url}/message/monad/cbor"))
            .header("content-type", request.content_type())
            .body(request.body().to_vec())
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body: serde_json::Value =
            serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
        (status, body)
    };
    let replay_hash = |fixture: &NativeDirectoryFixture| {
        let request = replay_fixture();
        let frank_cbor::ValidationResult::Parsed(frame) =
            frank_cbor::validate_frame(request.delivery(), &frank_cbor::default_context()).unwrap()
        else {
            panic!("replay delivery frame");
        };
        let Some(frank_cbor::TypedPayload::DirectMessage { payload_digest, .. }) =
            frame.typed.as_deref()
        else {
            panic!("replay direct message");
        };
        let digest: [u8; 32] = payload_digest.as_slice().try_into().unwrap();
        assert!(fixture
            .registry
            .canonical_dm()
            .get(&digest)
            .unwrap()
            .is_none());
        digest
    };

    let runtime_server = server(&fixture, &rpc_url);
    let (url, http_stop, http_task) = serve_http(
        runtime_server
            .clone()
            .into_router_with_directory(Some(fixture.directory.clone())),
    )
    .await;
    let outcome = std::panic::AssertUnwindSafe(async {
        // The replay is a well-formed, fully admissible request on its own merits.
        assert!(admitted_input(&fixture, &replay).await.is_ok());
        let (status, accepted) = put(url.clone(), genuine.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(accepted["phase"], "delivered");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let (status, refused) = put(url.clone(), replay.clone()).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(refused["error"], "canonical_submission_conflict");
        // Refused before anything is stored or broadcast.
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        replay_hash(&fixture);
        tokio::time::sleep(REBROADCAST_INTERVAL).await;
        let (status, retried) = put(url.clone(), genuine.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(retried, accepted);
        hash_hex(accepted["identity"]["payload_hash"].as_str().unwrap()).unwrap()
    })
    .catch_unwind()
    .await;
    http_stop.send(()).unwrap();
    http_task.await.unwrap();
    drop(runtime_server);
    let paid = match outcome {
        Ok(paid) => paid,
        Err(panic) => {
            rpc_stop.send(()).unwrap();
            rpc_task.await.unwrap();
            fixture.stop().await;
            std::panic::resume_unwind(panic);
        }
    };

    let reopened = fixture.reopen().await;
    let runtime_server = server(&reopened, &rpc_url);
    let (url, http_stop, http_task) = serve_http(
        runtime_server
            .clone()
            .into_router_with_directory(Some(reopened.directory.clone())),
    )
    .await;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = reopened.registry.canonical_dm();
        let delivered = owner.get(&paid).unwrap().unwrap();
        assert!(matches!(delivered.phase, Phase::Delivered(_)));
        let (status, refused) = put(url.clone(), replay.clone()).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(refused["error"], "canonical_submission_conflict");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        replay_hash(&reopened);
        let (status, retried) = put(url.clone(), genuine.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(retried["phase"], "delivered");
        let recipient = delivered.policy.recipient().unwrap();
        assert_eq!(owner.inbox(recipient, 0, None, 8).unwrap().len(), 1);
        assert!(owner.recovery(recipient, None, 8).unwrap().is_empty());
    })
    .catch_unwind()
    .await;
    http_stop.send(()).unwrap();
    http_task.await.unwrap();
    rpc_stop.send(()).unwrap();
    rpc_task.await.unwrap();
    reopened.stop().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
