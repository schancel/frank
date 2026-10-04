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
