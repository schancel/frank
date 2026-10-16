// Tagalog catalog. Protocol names and asset symbols retain their canonical spelling.
export default {
  negotiationRecovery: {
    'restoring': 'Ibinabalik ang kasaysayan ng swap',
    'scanning': 'Sinusuri ang kasaysayan ng swap',
    'ready': 'Naibalik ang kasaysayan ng swap',
    'unsupported': 'Hindi available ang pagbawi ng swap sa network na ito',
    'incomplete': 'Hindi kumpleto ang pagsusuri sa kasaysayan ng swap',
    'capacity': 'Puno na ang imbakan ng kasaysayan ng swap',
    'storage-error': 'Hindi maibalik ang kasaysayan ng swap',
  },
  qrScanner: {
    paymentHint:
      'Para sa pagbabayad, i-scan ang Receive QR code ng wallet. Ang profile QR code ay kumikilala sa isang contact sa pagmemensahe at hindi address para sa deposito sa wallet.',
    open: 'I-scan ang QR code',
    title: 'I-scan ang address',
    network: 'Network: {network}',
    addressOnly:
      'I-scan ang mismong address para sa network na ito. Suriin bago kumpirmahin. Hindi suportado ang mga link sa pagbabayad.',
    starting: 'Sinisimulan ang camera…',
    scanning: 'Itutok ang camera sa QR code.',
    invalid:
      'Ang QR code na ito ay hindi suportadong address para sa network na ito.',
    denied:
      'Hindi pinayagan ang access sa camera. Payagan ito o manu-manong ilagay ang address.',
    unavailable:
      'Hindi available ang camera. Gumamit ng HTTPS at suportadong browser, o manu-manong ilagay ang address.',
    retry: 'Subukang muli',
    manual: 'Manu-manong ilagay',
  },
  notificationPermission: {
    title: 'Mga abiso',
    default: 'Hindi naka-enable ang mga abiso ng browser.',
    granted: 'Naka-enable ang mga abiso ng browser.',
    denied:
      'Naka-block ang mga abiso ng browser. Payagan ang mga ito sa mga setting ng site sa iyong browser, pagkatapos ay bumalik sa Frank.',
    unsupported: 'Hindi suportado ng browser na ito ang mga abiso sa desktop.',
    enable: 'Paganahin ang mga abiso',
    notNow: 'Huwag muna',
    offer: 'Maabisuhan kapag may dumating na mga mensahe',
    offerHint:
      'Paganahin ang mga abiso ng browser ngayon, o sa ibang pagkakataon sa Mga Setting → Mga Abiso.',
    contactHint:
      'Hiwalay ang kagustuhan sa abiso ng bawat contact sa pahintulot na ito ng browser.',
    failed:
      'Hindi mapagana ang mga abiso. Suriin ang mga setting ng site sa iyong browser.',
  },
  startupFailure: {
    title: 'Hindi mai-load ang naka-save na data',
    message:
      'Huminto ang pagsisimula. Hindi ni-reset ang iyong naka-save na data.',
    loading: 'Nilo-load ang naka-save na data',
  },
  tempoPayment: {
    interrupted:
      'Kailangang suriin ang isang pagbabayad sa Tempo. Bumalik sa account na nagsimula nito at tingnan ang Aktibidad ng pagbabayad. Ipagpatuloy doon ang parehong pagbabayad kung hihilingin; huwag gumawa ng panibagong pagbabayad para rito.',
    dismiss: 'Isara',
  },
  accountRecovery: {
    mera_title: 'Mera',
    mera_choose:
      'Gumamit ng kasalukuyang passkey, o gumawa ng bagong account gamit ang bagong passkey.',
    mera_existing: 'Gamitin ang kasalukuyang passkey',
    mera_new: 'Gumawa ng bagong passkey',
    mera_create: 'Gumawa gamit ang Mera',
    mera_login: 'Magpatuloy gamit ang Mera (Passkey)',
    mera_verification_unreachable:
      'Hindi maverify ang kasalukuyang account. Handa nang kumpirmahin ang iyong passkey account; suriin ang koneksyon bago magpatuloy.',
    mera_description:
      'Lumilikha ng bagong Frank account ang bagong passkey. Mag-log in gamit ang kasalukuyang passkey upang bumalik sa parehong account sa website na ito. Maaari ka ring mag-save ng mga bahagi para sa pagbawi mula sa backup ng account.',
    mera_unsupported:
      'Kailangan ng mga passkey ang isang ligtas na website at suportadong browser. Sa halip, gamitin ang paggawa ng account o mga bahagi para sa pagbawi.',
    mera_cancelled:
      'Kinansela o nag-time out ang kahilingan sa passkey. Walang account na na-activate. Subukang muli kapag handa na.',
    mera_prf:
      'Hindi ibinigay ng passkey o browser na ito ang kinakailangang PRF secret. Walang account na na-activate. Subukan ang suportadong passkey provider at browser, o gamitin ang mga bahagi para sa pagbawi.',
    mera_failed:
      'Hindi natapos ang kahilingan sa passkey. Walang account na na-activate. Subukang muli gamit ang parehong passkey. Maaaring nalikha na ang isang passkey bago ang pagkabigong ito; gamitin ang pag-log in gamit ang kasalukuyang passkey upang subukan ito muli.',
    wallet_chain_mismatch:
      'Hindi tumutugma ang naka-save na wallet na ito sa network o configuration ng account na ginagamit ng app. Ibalik ang dating configuration ng network at subukang buksan muli ang kasalukuyang account. Hindi nabago ang naka-save nitong data.',
    profile_restore_unreachable:
      'Nabawi ang iyong account, ngunit hindi makuha ang profile nito. Suriin ang koneksyon sa relay at subukang muli.',
    profile_restore_retry: 'Subukang hanapin muli ang profile',
    pending_outdated_cancel_and_redo:
      'Na-save ang pagtatangkang ito ng mas lumang bersyon ng Frank at hindi ito maaaring i-activate. Kanselahin ito, pagkatapos ay gumawa o magbalik muli ng account. Maibabalik pa rin ng mga bahaging isinulat mo ang account.',
    pending_retry:
      'Hindi natapos ang paglilinis ng nakabinbing account. Hindi nabago ang iyong aktibong account. Subukang muli o kanselahin ang pagtatangkang ito bago magsimula ng iba.',
    balance_loading: 'Nilo-load ang balanse…',
    balance_unavailable: 'Hindi available ang balanse. Sinusubukang muli.',
    balance_stale:
      'Huling nalalamang balanse — nabigo ang pag-refresh. Maaaring luma na ang halagang ito.',
    profile_unavailable:
      'Hindi pa available ang paglalathala ng pampublikong profile at direktang pagmemensahe para sa account na ito. Walang ilalathalang lumang directory identity. Hindi nabago ang lokal na pangalan ng iyong account.',
    open_navigation: 'Buksan ang nabigasyon',
    frank_account: 'Account sa Frank',
    saved_account_data_could_not_be_opened:
      'Hindi mabuksan ang naka-save na data ng account. Hindi ito pinalitan. Kailangan ng preview na ito ang naka-encrypt na imbakan ng browser; hindi suportado ang mga native app.',
    retry_opening_account: 'Subukang muli',
    reset_account_storage: 'I-reset ang imbakan',
    reset_account_storage_confirm:
      'Buburahin ng pag-reset ng sirang imbakan ang lokal na data ng account na hindi mabuksan. Pagkatapos, maibabalik mo ang account mula sa mga bahagi ng backup. Magpatuloy?',
    a_saved_account_attempt_is_pending_it:
      "May nakabinbing naka-save na pagtatangka sa account. Hindi ito aktibo hangga't hindi mo pinipili ang I-activate ang account.",
    account_found: 'Kumpirmahin ang pagkakakilanlan',
    activate_account: 'I-activate',
    pending_identity_address:
      'Bubuksan ng pag-activate ang account na may identity address na ito. Hiwalay na ilo-load ang inilathalang profile nito:',
    pending_username: 'Username',
    pending_profile_loading: 'Sinusuri ang inilathalang profile…',
    pending_profile_unreachable:
      'Hindi masuri ang inilathalang profile. Suriin ang koneksyon sa relay at subukang muli. Maaari mo pa ring kumpirmahin ang identity address.',
    pending_profile_unverified:
      'Hindi maverify ang natanggap na profile para sa pagkakakilanlang ito. Suriin ang identity address bago i-activate.',
    pending_identity_stop_if_unexpected:
      'Kung nagbabalik ka ng account at hindi ito ang inaasahan mong address, huminto: huwag i-activate. Kanselahin na lang ang pagtatangka.',
    the_attempt_is_incomplete_or_awaiting_cleanup:
      'Hindi kumpleto ang pagtatangka o naghihintay ito ng paglilinis. Tahasang kanselahin ito bago magsimula ng ibang account.',
    cancel_pending_attempt: 'Kanselahin',
    create_a_frank_account_backup_or_restore:
      'Gumawa ng Frank account at backup nito, o magbalik ng isa mula sa naka-save mong mga bahagi para sa Pagbawi. Walang kailangang pondo para sa lokal na pag-activate.',
    an_existing_legacy_account_is_quarantined_its:
      'Nakahiwalay sa quarantine ang isang kasalukuyang lumang account. Hindi ginalaw ang naka-save nitong data at hindi ito binubuksan bilang karaniwang account.',
    changing_accounts_replaces_the_active_local_account:
      'Pinapalitan ng pagpapalit ng account ang aktibong lokal na account matapos kumpirmahin ang backup. Itago ang kasalukuyan mong backup.',
    i_understand_this_changes_the_active_local:
      'Nauunawaan kong binabago nito ang aktibong lokal na pagkakakilanlan at hindi nito inililipat ang pondo o kasaysayan.',
    new_account: 'Bagong Account',
    restore_account: 'Ibalik ang account',
    legacy_recovery_migration: 'Pagbawi ng lumang account',
    return_to_wallet: 'Bumalik',
    this_identifies_your_old_account_locally_you:
      'Ilagay ang BIP39 phrase na naka-save para sa iyong Frank account. Suriin ang identity address nito bago i-activate. Kukunin ang kasalukuyan mong profile pagkatapos ng pagbawi.',
    legacy_bip39_recovery_phrase: 'BIP39 recovery phrase ng lumang account',
    identify_legacy_account_locally: 'Ibalik ang BIP39 account',
    old_account: 'Lumang account:',
    the_new_identity_is_different_no_funds:
      '. Iba ang bagong pagkakakilanlan; walang pondo, kasaysayan o malalayong key na inililipat.',
    choose_how_many_shares_you_must_retain:
      'Piliin kung ilang bahagi ang kailangan mong itago. Permanenteng mawawala ang access kapag masyadong maraming bahagi ang nawala. Itago ang mga bahagi sa magkakahiwalay na ligtas na lugar; sinumang may sapat na bilang ay maaaring bumawi ng account.',
    generate_frank_account_backups: 'Gumawa ng mga backup',
    frank_account_backup: 'Backup ng Frank account',
    save_each_share_before_moving_on_exactly:
      '. I-save ang bawat bahagi bago magpatuloy. Eksaktong',
    consistent_shares_are_required_to_confirm:
      'magkakatugmang bahagi ang kailangan para makumpirma.',
    frank_account_backup_share: 'Bahagi ng backup ng Frank account',
    copy_this_share: 'Kopyahin ang bahaging ito',
    save_two_independent_copies_of_this_public:
      'Mag-save ng dalawang magkahiwalay na kopya ng pampublikong account descriptor na ito kasama ng iyong mga rekord sa pagbawi. Itinutugma nito ang nabawing account, ngunit hindi ito kusang nagpapatunay ng pagmamay-ari. Gamitin ang sarili mong hiwalay na naka-save na kopya kapag nagbabalik.',
    public_frankdesc_descriptor: 'Pampublikong frankdesc descriptor',
    copy_public_descriptor: 'Kopyahin ang pampublikong descriptor',
    i_saved_two_independent_copies_of_the:
      'Nag-save ako ng dalawang magkahiwalay na kopya ng pampublikong descriptor.',
    confirm_my_saved_backups: 'Kumpirmahin ang mga backup',
    enter_the_public_frankdesc_descriptor_from_an:
      'Ilagay muna ang pampublikong frankdesc descriptor mula sa isang hiwalay na naka-save na kopya. Metadata ito para sa pagtutugma ng account, hindi kusang nagpapatunay ng pagmamay-ari. Huwag kailanman gumamit ng descriptor na hinango mula sa mga isinumiteng bahagi.',
    independently_saved_frankdesc_descriptor:
      'Hiwalay na naka-save na frankdesc descriptor',
    pin_expected_account: 'Itakda ang inaasahang account',
    re_enter_exactly: 'Ilagay muli ang eksaktong',
    saved_frank_account_backup_shares_we_reconstruct:
      'naka-save na mga bahagi ng backup ng Frank account. Binubuo naming muli at ikinukumpara ang buong account bago ihanda.',
    enter_at_least_the_threshold_number_of_shares:
      'Ilagay ang hindi bababa sa kinakailangang bilang na nakasulat sa backup, isang bahagi bawat linya. Ang dagdag na mga bahagi mula sa parehong backup ay tumutulong sa app na matukoy at sabihin sa iyo kung alin ang mali.',
    share_report_title: 'Ito ang nakita ng app sa mga bahaging inilagay mo:',
    share_report_supports: 'Bahagi {n} (index {index}): ginamit.',
    share_report_inconsistent:
      'Bahagi {n} (index {index}): hindi kabilang sa backup na ito. Mali o sira ito.',
    share_report_different_set:
      'Bahagi {n} (set {identifier}): mula sa ibang set ng backup.',
    share_report_duplicate: 'Bahagi {n}: inilagay nang higit sa isang beses.',
    share_report_invalid:
      'Bahagi {n}: hindi mabasa. Suriin kung may maling pagkakatipa.',
    restore_choose_explained:
      'Naglalaman ang mga bahaging ito ng kumpletong backup ng higit sa isang account. Hindi pipili ang Frank para sa iyo. Kung hindi mo ito inaasahan, maaaring may nagbigay sa iyo ng mga bahagi ng account na kontrolado nila. Ibalik lamang ang address na nakikilala mo.',
    restore_choose_identity: 'Account na may identity address na ito:',
    restore_choose_shares: 'Binuo mula sa mga bahaging {shares}.',
    restore_choose_pick: 'Ibalik ang account na ito',
    expected_account: 'Inaasahang account:',
    insufficient_share_set:
      'Backup {identifier}: {available} magkakaibang bahagi ang available; {required} ang kailangan.',
    saved_codex32_shares_one_per_line:
      'Mga naka-save na bahagi para sa pagbawi, isa bawat linya',
    display_name: 'Pangalang ipapakita',
    display_name_required:
      'Kailangan. Ito ang pangalang makikita ng mga taong pinapadalhan mo ng mensahe; maaari mo itong baguhin sa profile mo sa ibang pagkakataon.',
    verify_backups_and_stage_account:
      'Iverify ang mga backup at ihanda ang account',
    cancel_and_start_again: 'Kanselahin',
    browser_preview_encrypted_local_storage_does_not:
      'Preview sa browser: hindi proteksyon ang naka-encrypt na lokal na imbakan laban sa mapaminsalang code sa origin na ito o pagnanakaw ng buong profile ng browser. Magtago ng magkakahiwalay na backup. Maaaring mawala ang access kapag binura ang lokal na data.',
    messaging_is_unavailable_for_typed_accounts_in:
      'Hindi available ang pagmemensahe para sa mga typed account sa preview na ito.',
    main_wallet: 'Pangunahing wallet',
    frank_account_recovery: 'Pagbawi ng Frank account',
    backup_shares_were_verified_before_activation_keep:
      'Naverify ang mga bahagi ng backup bago ang pag-activate. Ingatan ang iyong naka-save na mga kopya. Hindi muling mabubuo ng nakaimbak na mga domain root ang orihinal na master secret o mga bahagi ng backup.',
    public_recovery_descriptor: 'Pampublikong descriptor para sa pagbawi',
    fingerprint: 'Fingerprint:',
    create_or_restore_account: 'Gumawa o magbalik ng account',
    frank_account_backups_were_verified_before_activation:
      'Naverify ang mga backup ng Frank account bago ang pag-activate. Itago ang mga naka-save na bahagi at pampublikong descriptor; hindi muling magagawa ng device na ito ang orihinal na mga bahagi ng backup.',
    browser_storage: 'Imbakan ng browser',
    browser_persistence_reduces_automatic_eviction_it_is:
      'Binabawasan ng persistent storage ng browser ang awtomatikong pag-aalis ng data. Hindi ito backup o proteksyon laban sa mapaminsalang code o ninakaw na profile ng browser.',
    request_persistent_storage: 'Humiling ng persistent storage',
    keep_independent_account_backup:
      'Magtago ng hiwalay na backup ng iyong account. Hindi backup ang proteksyon sa imbakan ng browser.',
    import_bip39_seed: 'Mag-import ng BIP39 seed',
    not_backed_up_tooltip:
      'Hindi mo pa na-back up ang wallet o pagkakakilanlan mo. Pindutin upang mag-back up ngayon.',
    backup_account_codex32: 'I-back up ang account',
    codex32_threshold_explainer:
      'Isulat ang bawat bahagi. Alinmang {threshold} sa {count} bahaging ito ang makapagbabalik ng orihinal na account secret at derivation nito.',
    codex32_backup_sets_do_not_mix:
      'Bagong set ito. Hindi maaaring pagsamahin ang mga bahagi mula sa magkakaibang set, kasama ang ipinakita noong ginawa ang account. Gumagawa ng ibang set ang pagbabago ng scheme o muling pagbukas ng pahinang ito, kaya tapusin munang isulat ang set na ito.',
    cancel_scheme: 'Kanselahin',
    recovery_shares_privacy:
      'Sinumang makakita ng mga bahaging ito ay maaaring kunin ang account na ito. Siguraduhing walang ibang nakakakita ng screen mo.',
    codex32_backup_unavailable_for_account:
      'Hindi available sa device na ito ang orihinal na secret na kailangan upang gumawa ng mga bahagi ng backup. Balido pa rin ang kasalukuyan mong backup.',
    historical_share_keep_both_lines:
      'Itago nang magkasama ang mga linyang Seed at Check bilang isang bahaging nakasulat sa papel. Ilagay nang magkasama ang parehong linya kapag nagbabalik.',
    backup_seed_line: 'Seed',
    backup_check_line: 'Check',
    configure_scheme: 'Itakda ang kinakailangang bilang at mga bahagi',
    custom_threshold_shares: 'Sariling kinakailangang bilang at mga bahagi',
    threshold: 'Kinakailangang bilang',
    total_shares: 'Kabuuang mga bahagi',
    apply: 'Ilapat',
    generating_codex32_backup_shares:
      'Ginagawa ang mga bahagi para sa pagbawi…',
    share: 'Bahagi',
    copy_share: 'Kopyahin',
    verify_shards_title: 'Iverify ang mga bahagi',
    verify_shards_explainer:
      'Subukan ang naka-save mong mga bahagi sa pamamagitan ng paglalagay ng hindi bababa sa kinakailangang bilang upang maverify na nabubuo nilang muli ang iyong account.',
    verify_shards_button: 'Iverify ang mga bahagi',
    verify_shards_clear: 'Burahin',
    verify_shards_success:
      'Matagumpay na naverify ang mga bahagi! Balido ang iyong backup.',
    advanced_details: 'Mga detalyadong impormasyon',
    advanced_options: 'Mga advanced na opsyon',
    relay_server: 'Relay server',
    relay_server_url: 'URL ng Relay Server',
    relay_server_url_hint:
      'Pangunahing relay server para sa iyong naka-encrypt na mailbox at profile',
    reset_to_default_relay: 'Ibalik sa default na relay',
    invalid_relay_url: 'Maglagay ng balidong HTTP o HTTPS URL',
    relay_discovered:
      'Nahanap ang kasalukuyang pangunahing relay: {url}. Awtomatikong na-configure.',
    frank_is_open_in_another_tab: 'Bukas ang Frank sa ibang tab',
    multi_tab_notice:
      'Naka-save pa rin ang account mo sa device na ito. Aktibo ang Frank sa ibang tab o window. Upang protektahan ang wallet mo, isa lamang ang maaaring gumamit ng account sa bawat pagkakataon. Piliin ang “Gamitin ang Frank dito” upang magpatuloy dito at i-pause ang kabilang tab.',
    use_frank_here: 'Gamitin ang Frank dito',
    switch_to_open_tab: 'Hanapin ang bukas na Frank tab',
    find_tab_waiting: 'Kinokontak ang bukas mong Frank tab…',
    find_tab_focused:
      'Tumugon ang bukas mong Frank tab. Kung hindi ito lumitaw, piliin ito sa browser mo.',
    find_tab_notified:
      'Nagpadala ng abiso mula sa bukas mong Frank tab. I-click ito upang bumalik doon. Kung hindi ito lumitaw, piliin ang tab sa browser mo.',
    find_tab_manual:
      'Tumugon ang bukas mong Frank tab, ngunit hindi awtomatikong makalipat dito ang browser.',
    find_tab_unavailable:
      'Hindi tumugon ang bukas mong Frank tab. Maaaring sinuspinde ito ng browser mo.',
    find_tab_idle:
      'Hanapin ang bukas mong Frank tab o piliin ang “Gamitin ang Frank dito”.',
    find_tab_notification_title: 'Ang bukas mong Frank tab',
    find_tab_notification_body:
      'I-click ang abisong ito upang bumalik sa Frank tab na gumagamit ng account mo.',
    manual_tab_switch_hint:
      'Piliin ang Frank tab sa tab bar o pangkalahatang tanaw ng mga tab ng browser mo. Kung hindi mo ito makita, piliin ang “Gamitin ang Frank dito” upang ilipat ang account mo sa tab na ito.',
    tab_yielded_notice: 'Aktibo ang Frank sa ibang tab o window.',
  },
  agree: 'Sumang-ayon',
  chat: {
    groupRecipientNoticeSelf:
      'Ang mga mensaheng ipinapadala mo rito ay mga tala para sa sarili mo. Walang ibang nag-post dito ang makatatanggap nito.',
    groupRecipientNotice:
      'Kay {name} lamang mapupunta ang mga mensahe mo rito, hindi sa lahat ng nasa pag-uusap na ito.',
    sendMessage: 'Magpadala ng mensahe',
    stampPreparationChecking: 'Sinusuri ang mga pribadong stamp account…',
    stampPreparationFunding:
      'Inihahanda ang mga pribadong stamp account ({completed}/{total} on-chain na transaksyon; hanggang {feeReserve} {unit} na reserba sa bayarin bawat isa)…',
    stampPreparationReady:
      'Handa na ang mga pribadong stamp account; ipinapadala ang mensahe…',
    stampPreparationWaiting: 'Hinihintay makumpirma ang naunang pagbabayad…',
    stampPreparationWaitingBlocks:
      'Hinihintay makumpirma ang naunang pagbabayad ({blocks} block na lang)…',
    sendContextChanged:
      'Nagbago ang account, chain o pag-uusap. Suriin muli ang aksyon.',
    chainUnreachable:
      'Hindi makontak ang network. Nakapila ang mga bayad na mensahe at ipapadala kapag bumalik ito.',
    donationMessage:
      'Salamat sa pakikibahagi sa aming pangarap para sa hinaharap ng online na komunikasyon. Isaalang-alang ang pag-donate sa aming mga pagsisikap sa pamamagitan ng pagpapadala ng tunay na BCH sa bitcoincash:qq7vt04md0pt6fk5szhcx4cgsfuzmppy5u4hxshr4a',
  },
  stampPreparation: {
    refreshStatus: 'I-refresh ang katayuan',
    posting: 'Nagpo-post…',
    voting: 'Bumoboto…',
    sendingVote: 'Ipinapadala ang boto…',
    postCreated: 'Nagawa ang post sa {topic}.',
    replyParentLoading: 'Nilo-load ang post na sinasagutan mo…',
    replyParentUnavailable:
      'Hindi mai-load ang post na sinasagutan mo. Maaari mong subukang muli.',
    retryReplyParent: 'Subukang muli',
    postedRefreshFailed:
      'Nailathala ang post mo, ngunit nabigo ang pag-refresh. I-reload upang makita ito. Huwag itong i-post muli.',
    postOutcomeUnknown:
      'Maaaring nailathala na ang post mo. I-reload upang tingnan kung naroon ito. Huwag itong i-post muli.',
    votedRefreshFailed:
      'Naipadala ang boto mo, ngunit nabigo ang pag-refresh. I-reload upang makita ito. Huwag bumoto muli.',
  },
  forum: {
    postsLabel: 'mga post',
    noPosts: 'Wala pang mga post.',
    outageTitle: 'Hindi available ang forum',
    outageDescription:
      'Hindi makakonekta sa forum relay. Suriin ang koneksyon mo o subukang muli.',
    outageBanner:
      'Hindi makontak ang forum relay sa ngayon. Ipinapakita ang mga naka-save na post.',
    degradedTitle: 'Mahina ang koneksyon',
    degradedBanner: 'Hindi ma-update ang ilang paksa sa forum.',
    retry: 'Subukang muli',
    loginSignUp: 'Mag-log in / Mag-sign up',
    thread: 'Usapan',
    allTopics: 'Lahat ng paksa',
    filteredBy: 'Sinala ayon sa paksa',
    clearTopicFilter: 'Alisin ang filter',
    percentileFilter: 'Filter ayon sa percentile',
    allPosts: 'Lahat ng post',
    editor: {
      toolbar: 'Mga tool sa pag-format',
      bold: 'Makapal',
      italic: 'Nakahilig',
      heading: 'Pamagat',
      quote: 'Sipi',
      code: 'Code',
      bullet: 'Listahang may bullet',
      link: 'Link',
      attachImage: 'Mag-attach ng Larawan',
      imageProcessing: 'Pinoproseso ang larawan…',
      imageTooLarge:
        'Masyadong malaki ang larawan para sa post (dapat mas mababa sa 120 KB matapos i-compress)',
      imageError: 'Nabigong iproseso ang naka-attach na larawan',
      invalidImageType: 'Pumili ng balidong image file (PNG, JPEG, WebP, GIF)',
      removeAttachment: 'Alisin ang attachment',
    },
  },
  chatLayout: {
    invalidSubject:
      'Gumamit ng paksang hanggang 512 UTF-8 byte at walang control character.',
    participantCount: '{count} kalahok',
    editSubject: 'I-edit ang paksa',
    subject: 'Paksa',
    saveSubject: 'I-save',
    cancelSubject: 'Kanselahin',
    info: 'Impormasyon',
    infoTitle: 'Impormasyon',
    mute: 'I-mute',
    unmute: 'I-unmute',
    selectMessages: 'Burahin ang mga mensahe',
    selectMessagesTitle: 'Burahin ang mga mensahe',
  },
  chatInput: {
    giveLotusSecretly: 'Magbigay ng Lotus nang Lihim',
    sendStealth: 'Magpadala nang Stealth',
    offerSwap: 'Mag-alok ng Atomic Swap',
    attachImage: 'Mag-attach ng Larawan',
    removeAttachment: 'Alisin ang {name}',
    imageRefused: 'Hindi maipadala ang {name}: {reason}.',
    messageTooLarge:
      'Masyadong malaki ang mensaheng ito para maipadala. Alisin ang isang larawan o paikliin ang teksto.',
    blackjackChallenge: 'Hamon sa blackjack',
    placeHolder: 'Sumulat ng mensahe...',
    emojiPickerTitle: 'Pumili ng emoji',
    stampPrice: 'Presyo ng Stamp',
    stampPayment: 'Bayad sa stamp',
    stampQuickSelection:
      'Mabilis na pagpili: libre, mga bahagi, o mga multiple ng default',
    stampMultiplierValue: '{multiplier}× default ({amount})',
    defaultStamp: 'Default: {amount}',
    stampBelowMinimum:
      'Mas mababa ang halagang ito sa kasalukuyang minimum na {amount} {unit}. Pumili ng ibang halaga o libreng mensahe.',
    stampQuoteUnavailable: 'Hindi available ang default na stamp',
    fixedStampFallback:
      'Pansamantalang default: {amount} {unit}, batay sa nakapirming batayang halaga at kasalukuyang minimum na bayarin. Hindi available ang AVU rate.',
    stampQuoteUnavailableReason:
      'Hindi available ang default na stamp: {reason}. Pumili ng tiyak na halaga o libreng mensahe.',
    stampQuoteReasons: {
      'messaging-pending': 'kumokonekta pa ang account',
      'missing-rate': 'walang conversion rate',
      'stale-rate': 'luma na ang conversion rate',
      'missing-fee': 'hindi available ang pagtatantiya ng bayarin',
      'unsupported': 'hindi suportado ang pagmemensahe',
    },
    resetToDefault: 'Ibalik sa default',
    stampReset: 'Default',
    stampFree: 'Libre',
    stampChipFree: 'Walang stamp: libre ang mensaheng ito',
    stampChip: 'Stamp: {amount}',
    stampChipMultiple: 'Stamp: {amount}, {multiplier}× ng default',
    stampWhat:
      'Ang stamp ay maliit na bayad na kasama ng mensahe mo para sa taong sinusulatan mo. Bayad ito para sa kanilang atensyon.',
    stampWhy:
      'May default na stamp ang bawat mensahe maliban kung pumili ka ng ibang halaga para sa chat na ito. Ilagay ang 0 para magpadala ng libreng mga mensahe.',
  },
  digitalGoods: {
    catalog: 'Katalogo',
    buy: 'Bumili',
    confirmPrompt:
      'Magbayad ng {price} kay {name} ({address}) para sa "{item}"?',
    confirmBuy: 'Kumpirmahin at magbayad ng {price}',
    cancel: 'Kanselahin',
    confirmGroupLabel: 'Kumpirmahin ang pagbili ng {item}',
    priceUnavailable: 'hindi available ang presyo',
    hiddenOne: '{count} pang item ang hindi ipinapakita',
    hiddenMany: '{count} pang item ang hindi ipinapakita',
    requested: 'Hiniling: {itemId}',
    fulfilled: 'Narito ang binili mo ({itemId}):',
  },
  chatImage: {
    onePhoto: '📷 Larawan',
    manyPhotos: '📷 {count} larawan',
    notShown: 'Hindi ipinakita ang larawan ({reason})',
    reasonNotAnImage: 'hindi larawan',
    reasonTooLarge: 'masyadong malaki',
    reasonNotInline: 'hindi inline na larawan',
    reasonUnreadableHeader: 'hindi mabasang header ng larawan',
    reasonEmpty: 'walang laman ang larawan',
    reasonDimensionsTooLarge: 'masyadong malaki ang mga dimensyon',
  },
  raffle: {
    enter: 'Sumali',
    confirmGroupLabel: 'Kumpirmahin ang pagsali sa raffle',
    confirmPrompt: 'Magbayad ng {amount} para sumali?',
    confirm: 'Kumpirmahin',
    cancel: 'Kanselahin',
    insufficient: 'Higit iyon sa maaari mong gastusin ngayon ({balance}).',
    balanceUnknown: 'Hindi pa alam ang balanse mo.',
    leave: 'Umalis',
    leaveAriaLabel: 'Umalis sa round ng raffle na {raffleId}',
    leftAction: 'Umalis sa raffle',
    leftStatus:
      'Umalis sa raffle: {count}/{max} ang sumali. Na-refund ang bayad mo sa pagsali.',
  },
  gameFairness: {
    diceRejected: 'Walang ginawang paghagis.',
    diceRejectionReasons: {
      'roll-not-offered': 'Hindi inalok ang paghagis na ito.',
      'commitment-mismatch':
        'Hindi tumutugma ang commitment sa inalok na paghagis.',
      'invalid-client-seed': 'Hindi balido ang random value ng manlalaro.',
      'invalid-target': 'Hindi balido ang target ng paghagis.',
      'invalid-wager': 'Hindi balido ang taya.',
      'below-minimum': 'Mas mababa sa minimum ang taya.',
      'payout-limit': 'Lampas sa limitasyon ng mesa ang posibleng panalo.',
      'payment-not-confirmed': 'Hindi nakumpirma ang bayad sa taya.',
    },
    dicePractice: 'Pagsasanay',
    dicePracticeDescription:
      'Walang taya, walang bayad na panalo. Pareho ang mga tuntunin sa paghagis sa pagsasanay ngunit walang pondong itinataya.',
    dicePracticeRoll: 'Paghagis para sa pagsasanay',
    diceRoll: 'Ihagis',
    moveNotSent:
      'Hindi naipadala. Gamitin ang Subukang muli sa mensahe mo sa ibaba, o itapon ito upang pumili muli.',
    notVerified: 'HINDI NAVERIFY.',
    diceVerified:
      'Naverify: tumutugma ang secret sa commitment na tinayaan mo, at ang numero, resulta at bayad na panalo ay nagmumula rito at sa sarili mong random value.',
    diceHow: 'Paano ito sinuri',
    diceCommitment: 'Commitment (bago ang taya mo): {value}',
    diceSecret: 'Secret (isiniwalat): {value}',
    diceSeed: 'Ang random value mo: {value}',
    diceRule:
      'Dapat katumbas ng commitment ang SHA-256(secret); ang resulta ng paghagis ay ang unang 16 bit ng HMAC-SHA256(secret, ang value mo).',
    rpsVerified:
      'Naverify: tumutugma ang galaw at salt na isiniwalat ng bot sa commitment na ipinadala nito bago ka gumalaw.',
    payoutClaimed:
      'Bayad na panalo: {amount}. Sinasabi ng bot na kasama ito sa mensaheng ito; hindi pa ito naverify sa chain.',
    payoutMissing:
      'Bayad na panalo: {amount}, ngunit {carried} ang kasama ng mensaheng ito. Hindi ka pa nababayaran nang buo.',
    awaiting: 'Hinihintay ang pagsisiwalat ng bot ({seconds} s).',
    noAnswer:
      'Hindi pa sumasagot ang bot matapos ang {seconds} s. Nasa bot ang taya mo at wala pang isiniwalat.',
  },
  raffleDraw: {
    verified: 'Tumutugma ang bunot sa seed commitment',
    failed: 'Nabigo ang pagverify: {reason}',
    explainerToggle: 'Ano ang ipinapakita nito?',
    explainerShows:
      'Ipinapakita: hindi binago ng operator ang seed matapos itong i-commit, at nagmumula ang nanalo sa nakalistang mga kalahok at sa seed na iyon.',
    explainerNotShown:
      'Hindi ipinapakita: kung ang mga nakalistang kalahok ay may tunay na on-chain na bayad, o kung walang nilaktawang entry.',
    explainerCountUnverified:
      'Hindi inanunsyo ang laki ng round, kaya hindi nasuri ang bilang ng mga kalahok.',
  },
  persistentStorage: {
    tab: 'Imbakan',
    heading: 'Imbakang pinananatili ng browser',
    granted: 'Pinayagan',
    notGranted: 'Hindi pinayagan',
    unsupported: 'Hindi available',
    unknown: 'Sinusuri…',
    explainGranted:
      'Pumayag ang browser mo na protektahan ang naka-save na data ng Frank laban sa awtomatikong pag-aalis. Maaari pa rin itong mawala kapag binura ang data ng website. Magtago ng hiwalay na backup ng account.',
    explainNotGranted:
      'Nagse-save na ng data ang Frank sa device na ito. Nagdaragdag ang pahintulot na ito ng proteksyon laban sa awtomatikong pag-aalis; hindi ito nagdaragdag ng espasyo sa disk. Kung wala ito, maaaring alisin ng browser ang naka-save na data. Magtago ng hiwalay na backup ng account.',
    explainUnsupported:
      'Walang proteksyon laban sa awtomatikong pag-aalis ang browser o kontekstong ito. Makapagse-save pa rin ng data ang Frank, ngunit maaaring alisin ito ng browser. Magtago ng hiwalay na backup ng account.',
    request: 'Hilingin sa browser na panatilihin ang data ko',
    confirmSeed: 'Kumpirmahin ang recovery phrase ko',
    seedConfirmed: 'Nakumpirma ang recovery phrase mo.',
    safariTip:
      'Safari sa Mac (macOS Sonoma 14 o mas bago): piliin ang File > Add to Dock, buksan ang Frank mula sa Dock, at humiling muli ng proteksyon. Sa iPhone o iPad, gamitin ang Share > Add to Home Screen at buksan doon ang Frank. Browser pa rin ang magpapasya kung papayagan ang proteksyon; hindi ito ginagarantiya ng pag-bookmark lamang.',
    grantedToast: 'Pinayagan ng browser ang persistent storage.',
    declinedToast:
      'Hindi pinayagan ng browser ang proteksyon laban sa awtomatikong pag-aalis. Nakaimbak pa rin ang data mo. Tingnan ang gabay sa pag-install sa ibaba at subukang muli; hindi garantisado ang proteksyon.',
  },
  blackjackP2p: {
    cancel: 'Kanselahin',
    challengeDealerReview:
      'Pipili ang kabilang manlalaro ng taya sa loob ng limitasyong ito.',
    challengeBetLimit: 'Limitasyon ng taya',
    challengeBeforeBet:
      'Magbubukas ito ng isang laro. Suriin at kumpirmahin ang taya mo matapos tanggapin ng dealer.',
    preparingChallenge: 'Inihahanda ang hamon…',
    betSummary: 'Taya: {amount}',
    changeBet: 'Baguhin',
    confirmBet: 'Tumaya ng {amount}',
    notDeliveredYet:
      'Wala pa sa kabilang panig ang mensaheng ito: ipinapadala pa ito.',
    notDelivered:
      'Wala sa kabilang panig ang mensaheng ito: hindi ito naipadala. {reason}',
    retry: 'Ipadala muli',
    notNext:
      'Naipadala na ang galaw na ito sa blackjack o hindi na ito posible. Walang ipinadala.',
    cardDealtN: 'Baraha: {card}',
    playAgain: 'Maglaro muli',
    challengeTitle: 'Hamon sa isang laro ng blackjack',
    roleDealer: 'Ako ang dealer',
    rolePlayer: 'Ako ang manlalaro, sila ang dealer',
    maxBet: 'Pinakamataas na taya',
    limitDealer:
      'Maaari kang mag-alok ng hanggang {amount}: kailangang kayang bayaran ng dealer ang panalo sa dinobleng taya (4× ng taya) mula sa sarili nitong balanse.',
    limitPlayer:
      'Maaari kang tumaya ng hanggang {amount}: ang kaya mong gastusin ngayon.',
    sendChallenge: 'Ipadala ang hamon',
    challengeRefused:
      'Higit ang hamong ito sa saklaw ng balanse mo. Walang ipinadala.',
    balanceUnknown: 'Hindi pa na-load ang balanse mo.',
    enterAmount: 'Maglagay ng halagang higit sa zero.',
    belowStamp:
      'Hindi maaaring mas mababa ang halaga sa minimum na stamp ({amount}).',
    aboveOwnLimit: 'Higit iyon sa kaya mong sagutin (hanggang {amount}).',
    aboveMaxBet: 'Higit iyon sa pinakamataas na taya sa larong ito ({amount}).',
    lineChallengeDealer:
      'Hamon sa blackjack: ang nagpadala ang dealer. Pinakamataas na taya {amount}.',
    lineChallengePlayer:
      'Hamon sa blackjack: ang nagpadala ang manlalaro, ikaw ang dealer. Pinakamataas na taya {amount}.',
    lineAccept: 'Tinanggap ang hamon. Pinakamataas na taya {amount}.',
    line: {
      bet: 'Nailagay ang taya: ang stamp ng mensaheng ito ang taya.',
      deal: 'Naipamahagi ang mga baraha.',
      hit: 'Kumuha ng baraha.',
      stand: 'Manatili.',
      double:
        'Doblehin ang taya: ang stamp ng mensaheng ito ang ikalawang taya.',
      card: 'Naipamahagi ang baraha.',
      reveal:
        'Isiniwalat ang mga baraha: ang stamp ng mensaheng ito ang bayad na panalo, kung mayroon.',
      refund: 'Refund: ang stamp ng mensaheng ito ang ibinalik na pera.',
    },
    playerHand: 'Manlalaro: {cards} ({total})',
    dealerHand: 'Dealer: {cards} ({total})',
    dealerShows: 'Ipinapakita ng dealer: {card}',
    rowPlayer: 'Manlalaro',
    rowDealer: 'Dealer',
    rowCard: 'Baraha',
    wager: 'Nakataya: {amount}',
    accept: 'Tanggapin at mamahagi',
    betAmount: 'Taya mo (hanggang {max})',
    bet: 'Ilagay ang taya',
    hit: 'Kumuha ng baraha',
    stand: 'Manatili',
    double: 'Doblehin ang taya (+{amount})',
    payAndReveal: 'Magbayad ng {amount} at isiwalat',
    refund: 'I-refund ang {amount}',
    refundBet: 'Ibalik ang taya ({amount}) sa halip na mamahagi',
    waitAccept: 'Hinihintay ang pagtanggap ng kabilang panig.',
    waitBet: 'Hinihintay ang taya.',
    waitDealer: 'Hinihintay ang dealer.',
    waitPlayer: 'Hinihintay ang galaw ng manlalaro.',
    waitReveal: 'Hinihintay ang pagsisiwalat at pagbabayad ng dealer.',
    dealing: 'Namamahagi…',
    verified:
      'Nagmula ang mga baraha sa commitment ng parehong manlalaro, na sinuri sa device na ito.',
    badReveal:
      'Nagpadala ang dealer ng pagsisiwalat na hindi tumutugma sa commitment nito. Hindi pa tapos ang laro.',
    noSeed:
      'Wala sa device na ito ang seed ng larong ito, kaya hindi ito makapamamahagi. Maaari mong ibalik ang taya.',
    noSeedPlayer:
      'Wala sa device na ito ang seed mo para sa larong ito, kaya hindi nito magagawa ang galaw mo. Gamitin ang device kung saan mo inilagay ang taya.',
    refundOwed: 'May utang sa iyo ang dealer na refund na {amount}.',
    refunded: 'Ibinalik ng dealer ang taya ({amount}).',
    noPayout: 'Walang bayad na panalo.',
    paid: 'Nagbayad ang dealer ng {amount}.',
    shortPaid: '{owed} ang utang ng dealer ngunit {paid} ang ibinayad.',
    outcome: {
      player: {
        player_win: 'Panalo ka.',
        dealer_win: 'Panalo ang dealer.',
        push: 'Tabla: ibabalik ang taya mo.',
        player_blackjack: 'Blackjack! Panalo ka ng 3:2.',
      },
      dealer: {
        player_win: 'Panalo ang manlalaro.',
        dealer_win: 'Panalo ka.',
        push: 'Tabla: ibabalik ang taya.',
        player_blackjack: 'May blackjack ang manlalaro at panalo ng 3:2.',
      },
    },
  },
  a11y: {
    contactActions: 'Mga opsyon sa contact para kay {name}',
    openNavigation: 'Buksan ang menu ng nabigasyon',
    addContact: 'Magdagdag ng contact',
    addTopic: 'Magdagdag ng paksa',
    deleteTopic: 'Burahin ang paksang {topic}',
    deleteContact: 'Burahin ang contact na {name}',
    sendMessage: 'Magpadala ng mensahe',
    voteUp: 'Bumoto pataas',
    voteDown: 'Bumoto pababa',
    forumRefresh: 'I-refresh ang forum',
    newPost: 'Bagong post',
    forumSettings: 'Mga setting ng forum',
    topicSettings: 'Mga setting ng paksa',
    chatMenu: 'Mga opsyon sa chat',
    closeInfo: 'Bumalik sa chat',
    exitSelectMode: 'Lumabas sa pagbubura ng mensahe',
    attachmentOptions: 'Mga opsyon sa attachment',
    stampPayment: 'Bayad sa stamp',
    messageActions: 'Ipakita ang mga aksyon sa mensahe',
    replyToMessage: 'Sagutin ang mensahe',
    forwardMessage: 'Ipasa ang mensahe',
    messageInfo: 'Impormasyon ng mensahe',
    deleteMessage: 'Burahin ang mensahe',
    resendMessage: 'Ipadala muli ang mensahe',
    cancelReply: 'Kanselahin ang sagot',
    scrollToLatest: 'Mag-scroll sa pinakabagong mga mensahe',
    copyAddress: 'Kopyahin ang address',
    connectRelay: 'Kumonekta sa relay',
    choosePhoto: 'Pumili ng larawan sa profile',
    previousAvatar: 'Nakaraang avatar',
    nextAvatar: 'Susunod na avatar',
    openInExplorer: 'Buksan ang transaksyon sa block explorer',
    copyTxHash: 'Kopyahin ang transaction hash',
    backToForum: 'Bumalik sa forum',
    formatBold: 'Gawing makapal',
    formatItalic: 'Gawing nakahilig',
    formatHeading: 'Gawing heading',
    formatQuote: 'Gawing sipi',
    formatCode: 'Gawing code',
    formatBullet: 'Gawing listahang may bullet',
    formatLink: 'Maglagay ng link',
    attachPostImage: 'Mag-attach ng larawan sa post',
    formatting: 'Pag-format',
  },
  leftDrawer: {
    noForums: 'Wala pang natutuklasang forum.',
    settings: 'Mga Setting',
    chats: 'Mga Direktang Mensahe',
    contacts: 'Mga Contact',
    forum: 'Forum',
    wallet: 'Wallet',
    railLabel: 'Mga seksyon sa sidebar',
    chatsUnreadOne:
      'Mga Direktang Mensahe, {count} hindi pa nababasang mensahe',
    chatsUnreadOther:
      'Mga Direktang Mensahe, {count} hindi pa nababasang mensahe',
    contactsUnreadOne: 'Mga Contact, {count} hindi pa nababasang mensahe',
    contactsUnreadOther: 'Mga Contact, {count} hindi pa nababasang mensahe',
    loginSignUp: 'Mag-log in / Mag-sign up',
    welcome: 'Panimula',
  },
  welcome: {
    title: 'Maligayang pagdating sa Frank',
    tagline: 'May kapalit ang malayang pananalita.',
    subtitle:
      'Pribadong pagmemensaheng lumalaban sa spam sa pamamagitan ng gastos, sa Monad.',
    introText:
      'Pinagsasama ng Frank ang mga cryptographic na pagkakakilanlang hindi kailangan ng pahintulot at tunay na halagang nakataya. Nagbabayad ang mga nagpadala para sa atensyon, nagsusunog ng halaga ang mga pampublikong broadcast, at pinananatili ang privacy sa pamamagitan ng mga karaniwang stealth na transaksyon.',
    createAccount: 'Gumawa ng Account',
    createAccountSubtitle:
      'Gumawa ng lokal na cryptographic na pagkakakilanlan sa ilang segundo nang walang PII.',
    browseForum: 'Mag-browse sa Forum',
    browseForumSubtitle:
      'Magbasa ng mga pampublikong paksa at talakayan ng komunidad kahit walang account.',
    readDocs: 'Basahin ang Dokumentasyon',
    howItWorks: 'Paano Gumagana ang Frank',
    pillarFreeSpeechTitle: 'May Kapalit ang Malayang Pananalita',
    pillarFreeSpeechDesc:
      'Kapag walang gastos ang pagmemensahe, nangingibabaw ang mga bot at nagsesensor ang mga platform. Pinapalitan ng Frank ang mga tagapagbantay ng mga tuntuning pang-ekonomiya: binabayaran ng mga direktang mensahe ang tatanggap, at nagsusunog ng halaga ang mga pampublikong paksa.',
    pillarPrivacyTitle: 'Karaniwang Privacy at DKSAP',
    pillarPrivacyDesc:
      'Dinadala ang mga bayad sa hinangong stealth address na minsanan lamang ginagamit. Mukhang karaniwang peer-to-peer na gas transfer ang mga transaksyon, na lumilikha ng privacy sa pagkakahalo ng mga ito sa buong blockchain.',
    pillarIdentityTitle: 'Sariling Pagkakakilanlan nang Walang PII',
    pillarIdentityDesc:
      'Hindi kailangan ng numero ng telepono, SMS code, o email. Ang pagkakakilanlan mo ay lokal na secp256k1 keypair na buong hinango sa device mo.',
    pillarRelayTitle: 'Mga Federated na Mailbox Relay',
    pillarRelayDesc:
      'Nagruruta at nag-iimbak ang mga relay ng mga end-to-end encrypted na envelope nang hindi nakikita ang nababasang nilalaman ng mensahe o kumikilos bilang tagapagbantay ng pagkakakilanlan.',
  },
  docs: {
    title: 'Dokumentasyon',
    header: 'Dokumentasyon at Protocol',
    openInTab: 'Buksan sa Tab',
    iframeTitle: 'Dokumentasyon ng Frank',
  },
  walletPanel: {
    title: 'Mga Wallet',
    mainWallet: 'Pangunahing wallet',
    renameWallet: 'Palitan ang pangalan ng wallet',
    walletName: 'Pangalan ng wallet',
    saveName: 'I-save',
    cancel: 'Kanselahin',
    resetDefault: 'Ibalik sa default',
    testnet: 'Testnet',
    monad: 'Monad',
    monadTestnet: 'Monad Testnet',
    send: 'Magpadala ng MON',
    receive: 'Tumanggap ng MON',
    sendMont: 'Magpadala ng MONT',
    receiveMont: 'Tumanggap ng MONT',
    showSeed: 'Ipakita ang recovery phrase',
    confirmSeed: 'Kumpirmahin ang recovery phrase',
    balanceLoading: 'Nilo-load ang balanse…',
    relayUnavailable: 'Hindi available sa relay na ito.',
    balanceUnavailable: 'Hindi available ang balanse.',
    balanceUnsupported:
      'Hindi pa ipinapakita ang balanse para sa network na ito.',
    walletUnsupported:
      'Hindi pa suportado ang network na ito. Walang ipinapakitang address dahil hindi makikita ng app ang perang ipadadala rito.',
    notSupported: 'Hindi suportado',
    tokenBalancesLoading: 'Nilo-load ang mga balanse ng token…',
    tokenBalancesUnavailable: 'Hindi available ang mga balanse ng token.',
    tokenBalancesStale:
      'Hindi available ang mga balanse ng token. Ipinapakita ang huling nalalamang mga balanse.',
    balanceStale: '{balance} (huling nalalaman)',
    failedLoadAddress: 'Hindi mahango ang address ng wallet',
    receiveDiscoveryUnavailable:
      'Hindi masuri sa relay ang susunod na hindi pa nagagamit na address sa pagtanggap. Subukang muli kapag may koneksyon na.',
    receiveAddressUnavailable:
      'Hindi available ang address sa pagtanggap para sa account at network na ito. Subukang buksan ito muli.',
    retryAddress: 'Subukang kunin muli ang address',
    unableCopyAddress: 'Hindi makopya ang Monad address',
    ecash: 'eCash',
    ecashTestnet: 'eCash Testnet',
    solana: 'Solana',
    solanaTestnet: 'Solana Testnet',
    tempo: 'Tempo',
    tempoTestnet: 'Tempo Moderato',
    ethereum: 'Ethereum',
    ethereumTestnet: 'Sepolia',
    hyperliquid: 'Hyperliquid',
    hyperliquidTestnet: 'Hyperliquid Testnet',
    bitcoin: 'Bitcoin',
    bitcoinTestnet: 'Bitcoin Testnet',
    bitcoincash: 'Bitcoin Cash',
    bitcoincashTestnet: 'Bitcoin Cash Chipnet',
    dogecoin: 'Dogecoin',
    dogecoinTestnet: 'Dogecoin Testnet',
    litecoin: 'Litecoin',
    litecoinTestnet: 'Litecoin Testnet',
    bnb: 'BNB Chain',
    bnbTestnet: 'BNB Testnet',
    polygon: 'Polygon',
    polygonTestnet: 'Polygon Amoy',
    base: 'Base',
    baseTestnet: 'Base Sepolia',
    arbitrum: 'Arbitrum One',
    arbitrumTestnet: 'Arbitrum Sepolia',
    zeroXec: '0 XEC',
    zeroTxec: '0 tXEC',
    zeroSol: '0 SOL',
    zeroTsol: '0 tSOL',
    zeroUsd: '0 USD',
    zeroTusd: '0 tUSD',
    zeroEth: '0 ETH',
    zeroHype: '0 HYPE',
    zeroThype: '0 tHYPE',
    zeroBtc: '0 BTC',
    zeroTbtc: '0 tBTC',
    zeroBch: '0 BCH',
    zeroTbch: '0 tBCH',
    zeroDoge: '0 DOGE',
    zeroTdoge: '0 tDOGE',
    zeroLtc: '0 LTC',
    zeroTltc: '0 tLTC',
    zeroBnb: '0 BNB',
    zeroTbnb: '0 tBNB',
    zeroPol: '0 POL',
    zeroTpol: '0 tPOL',
    receiveXec: 'Tumanggap ng XEC',
    receiveTxec: 'Tumanggap ng tXEC',
    sendAsset: 'Magpadala ng {unit}',
    sendSol: 'Magpadala ng SOL',
    receiveSol: 'Tumanggap ng SOL',
    sendTsol: 'Magpadala ng tSOL',
    receiveTsol: 'Tumanggap ng tSOL',
    sendToContact: 'Magpadala sa Contact',
    legacySend: 'Lumang Paraan ng Pagpapadala',
    avuDialogTitle: 'Arbitrary Value Unit (AVU)',
    avuDialogSubtitle: '1 AVU ≡ 1 Kilowatt-Hour (kWh) ng Pisikal na Pagkuwenta',
    avuDialogDesc:
      'Hindi nagpapakita ang Frank ng mga fiat currency sa interface. Ikinukumpara ang mga balanse sa AVU, isang yunit ng pagtatala ng halaga: ang 1 AVU ay 1 kWh ng enerhiya. Ang enerhiyang katumbas ng isang yunit ng halaga ay hinango sa proof-of-work mining (presyo, block reward, difficulty at husay ng mining hardware ng isang pangkat ng mga miniminang coin), at ang AVU value ng isang coin ay ang presyo nito na minumultiplika sa numerong iyon. Hindi ito coin o token; pinahihintulutan nitong maikumpara ang alinmang dalawang coin gamit ang isang numero.',
    avuMemeHeading: 'Pagtanggi sa USD Meme',
    avuMemeDesc:
      'Ang US Dollar ay isang panlipunang meme na pinananatili ng mga default ng software at atas ng sentral na bangko. Ang pagtangging ipakita ang USD sa mga wallet na sariling pinamamahalaan ay sumisira sa sikolohikal na monopolyong iyon at nagpapahina sa meme, at muling iniuugnay ang kayamanan sa hindi nagbabagong mga batas ng thermodynamics.',
    avuSupplyChainHeading: 'Ang Ugat ng Bawat Supply Chain',
    avuSupplyChainDesc:
      'Bawat pisikal na produkto—pagkain, malinis na tubig, pabahay, semiconductor, at transportasyon—ay organisadong enerhiya sa pinakadiwa nito. Sa pagsukat ng halaga sa pisikal na enerhiya, sinusukat ang kakayahang bumili ayon sa pangunahing gastos ng pisikal na realidad.',
    avuCpiHeading:
      'Paglampas sa CPI upang Makita ang Tunay na Halaga ng Dollar',
    avuCpiDesc:
      'Tinatakpan ng mga sukatan ng Consumer Price Index (CPI) ng pamahalaan ang implasyon sa pamamagitan ng substitution bias at hedonic na mga pagbabago. "$100" pa rin ang nakasulat sa isang $100 na papel, na nagtatago sa paghina nito. Noong 1960, nakakabili ang $1 ng humigit-kumulang 91 kWh ng pang-industriyang kuryente sa US; noong 2025, humigit-kumulang 12 kWh na lang (EIA). Inilalantad ng pagsubaybay sa enerhiya sa paglipas ng panahon ang bilis ng paghina ng fiat currency.',
    avuOracleLessHeading: 'Tunay na "Oracle-Less"',
    avuOracleLessDesc:
      'Hindi tulad ng mga tradisyonal na DeFi oracle na umaasa sa mga pinagkakatiwalaang third-party feed, direktang vineverify sa chain ng mga full node ang Proof-of-Work difficulty at iskedyul ng paglabas ng coin, na nakabatay sa mapagkumpitensyang thermodynamics.',
    avuDialogClose: 'Isara',
    avuDrawerHeader: '1 AVU ≡ 1 kWh (?)',
    avuRatesTitle: 'Halaga ng isang yunit sa AVU',
    avuRatesAsset: 'Asset',
    avuRatesRate: 'Pisikal na Pagkuwenta (AVU / kWh)',
    tabBalance: 'Balanse at Paglipat',
    priceHistoryTitle: 'Kasaysayan ng presyo ng {symbol}',
    priceHistoryAxisHash: 'AVU (Hash) bawat {symbol}',
    priceHistoryAxisSpot: 'AVU (Spot) bawat {symbol}',
    priceHistoryAxisGold: 'Troy ounce ng ginto bawat {symbol}',
    priceHistoryHash: 'AVU (Hash)',
    priceHistorySpot: 'AVU (Spot)',
    priceHistoryGold: 'Ginto',
    priceHistoryPoints: '{count} obserbasyon ng presyo mula noong {first}.',
    priceHistoryCoverage:
      'May {count} obserbasyon ng presyo mula {first} hanggang {last}. Hiniling na saklaw: {range}.',
    priceHistorySinglePoint:
      'Isa lamang ang available na obserbasyon ng presyo sa saklaw na ito; walang iginuhit na linya.',
    priceHistoryGoldUnavailable:
      'Walang kamakailang may-petsang presyo ng Ginto para sa mga obserbasyong ito.',
    priceHistorySource: 'Pinagmulan ng presyo: {source}.',
    priceHistoryBenchmarkUnavailable:
      'Walang {benchmark} na pagpapahalaga para sa coin na ito sa saklaw na ito.',
    avuReferenceTitle: 'Halaga ng AVU sa US dollar',
    avuReferenceAxis: 'USD bawat AVU',
    avuReferenceHash: '1 AVU (Hash)',
    avuReferenceSpot: '1 AVU (Spot)',
    avuReferenceNoHistory:
      'Walang available na kasaysayan ng sanggunian ng AVU sa saklaw na ito.',
    avuReferenceSinglePoint:
      'Isa lamang ang available na obserbasyon para sa isang benchmark; walang iginuhit na linya para rito.',
    avuReferencePointCount: '{count} obserbasyon',
    avuReferenceMethod: 'Paano kinakalkula ang AVU',
    avuReferenceMethodText:
      'Sinusukat ng AVU (Hash) ang halaga ng enerhiya sa pamamagitan ng proof-of-work mining; gumagamit ang AVU (Spot) ng mga pakyawang presyo ng kuryente. Ang halaga sa dollar ng bawat isa ay ang kabaligtaran ng enerhiya bawat dollar nito. Nananatiling hindi available ang mga nawawalang input.',
    aboutAvu: 'Tungkol sa AVU',
    tabHistory: 'Kasaysayan',
    historyEmpty: 'Wala pang naitalang aktibidad sa network na ito.',
    historyPending: 'Nakabinbin at hindi pa nalulutas',
    historyUndated: 'Hindi available ang petsa',
    backToWallet: 'Bumalik sa wallet',
    avuReferenceMeasurement:
      'Ang isang AVU ay kumakatawan sa isang kilowatt-hour. Ipinapakita ng mga kurbang ito ang halaga nito sa US dollar gamit ang mga sukat ng mining at pakyawang kuryente.',
    avuReferenceSampling:
      'Ginagamit ng sukatan ng mining ang mga presyo ng coin, naobserbahang kita sa mining at hashrate, husay ng hardware at mga timbang ayon sa market cap. Kabilang sa mga makasaysayang input ang buwanang average at may-petsang mga pagbabago; nananatili ang bawat halaga hanggang sa susunod na obserbasyon nito. Maaaring manggaling sa alinman sa mga input na ito ang pagbabago sa kurba, hindi lamang sa hashrate.',
    tabParity: 'Kasaysayan ng presyo',
    tabSwap: 'Agarang Swap',
    swapUnavailable: 'Hindi available ang Agarang Swap',
    swapUnavailableDescription:
      'Hindi pa suportado ang mga swap. Walang available na quote o transaksyon.',
    assetsAndTokens: 'Mga Asset at Token',
    nativeCoin: 'Native na Coin',
    splToken: 'SPL Token',
    tokenMint: 'Token Mint',
    tokenContract: 'Kontrata ng token',
    recentActivity: 'Mga kamakailang swap',
    noRecentActivity: 'Wala pang swap sa chain na ito.',
    swapAction: 'Mag-swap',
    viewInExplorer: 'Tingnan sa Explorer',
    avuTooltip:
      '1 AVU ≡ 1 kWh (3.6 MJ) ng pisikal na pagkuwenta. Isang hindi mapapalsipikang thermodynamic na pamantayan ng tunay na kakayahang bumili.',
    avuHashLabel: 'AVU_hash: enerhiya bawat yunit ng halaga, mula sa mining',
    avuHashNote:
      'Average sa pangkat ng mga miniminang coin, na may timbang ayon sa market capitalization at limitasyon ng Bitcoin sa 60%: {weights}. Magkasamang minamina ang Litecoin at Dogecoin at binibilang bilang isang entry. Pinipili ang datos ng husay ng hardware: pagtatantiya ng Cambridge sa mga makinang talagang tumatakbo para sa SHA-256, ang pinakamahusay na makinang ibinebenta para sa scrypt at RandomX. Mas mahusay ang pinakamahusay na makina kaysa sa kabuuang pangkat ng makina, kaya mas mataas ang nababasang halaga bawat kWh ng dalawang entry na iyon kaysa sa katumbas na datos ng buong pangkat.',
    avuSpotLabel:
      'AVU_spot: pakyawang kuryente, na sinusukat gaya ng pagsukat ng mining sa halaga ng enerhiya',
    avuSpotNote:
      'Sa 1 AVU, nagkakatugma ang grid at mining. Presyo: average na day-ahead na presyo ng bawat rehiyon sa {window} araw hanggang {latest}, na pantay ang timbang ng mga rehiyon: {regions}.',
    avuUnitLabel: 'Ang yunit',
    avuUnitNote:
      'Yunit ng pagtatala ng halaga, hindi coin o token: walang hawak o ipinagpapalit sa AVU.',
    avuUnavailable: 'Hindi available',
    sourceEfficiency:
      'Husay ng hardware (piniling datos, hindi live na sukat): {sources}.',
    avuHashVsSpotNote:
      'Ang kinikita ng isang kWh ng mining kumpara sa pakyawang halaga ng isang kWh. Dapat ay halos magkatugma ang dalawa.',
    avuHashVsSpotLabel: 'Kita sa mining kumpara sa presyo ng grid',
    avuHashStale: 'Luma na: {age} na ang pinakalumang input.',
    avuHashLeftOutEfficiency: 'walang datos ng husay ng hardware',
    avuHashLeftOutPrice: 'walang presyo',
    avuHashLeftOutChain: 'walang estadistika ng chain',
    avuHashLeftOut: 'Hindi isinama: {coins}.',
    avuHashUnavailableNote:
      "Hindi makalkula ang AVU_hash: walang miniminang coin sa pangkat na may presyo at estadistika ng chain. Walang ipapakitang AVU value hangga't wala nito.",
    avuPriceFreshNote: 'Natanggap ang presyo {age} na ang nakalipas.',
    avuPriceStaleNote:
      'Luma na: natanggap ang huling presyo {age} na ang nakalipas.',
    avuStalePrice: '{rate} ({age} na ang tanda)',
    resetZoom: 'I-reset ang zoom',
    chartGoldAvu: 'Ginto (AVU bawat ounce)',
    rangeAll: 'LAHAT',
    range5Y: '5Y',
    range1Y: '1Y',
    range30D: '30D',
    range7D: '7D',
    range24H: '24H',
    rangeNetworks: 'Mga Network',
    chartNoteNoHistory:
      'Wala pang kasaysayan para sa saklaw na ito, kaya walang iginuhit na linya.',
    chartNoteNetworks:
      'Ang kinikita ng isang kWh ng mining sa bawat entry sa pangkat, sa AVU, kasama ang timbang ng entry: presyo × block reward ng minero ÷ inaasahang hash bawat block × hash bawat kWh, na sinusukat ayon sa pangkat. Ikinukumpara ng porsyento ito sa buong pangkat (1 AVU bawat kWh).',
    chartNoteNetworksUnavailable:
      'Hindi makalkula ang AVU_hash, kaya walang iginuhit.',
    sourcesTitle: 'Pamamaraan at mga Pinagmulan ng Data',
    sourceUnit:
      'AVU: 1 AVU = 1 kWh. Ang AVU_hash ay ang enerhiyang katumbas ng isang yunit ng halaga, na ina-average sa pangkat ng mga miniminang coin ayon sa market capitalization at may limitasyon ng Bitcoin sa 60%; para sa bawat entry, kita bawat kWh = presyo × block reward ng minero ÷ inaasahang hash bawat block × hash bawat kWh. Bawat AVU value ay presyo na minumultiplika sa AVU_hash.',
    avuHashValue: '{used} sa {total} entry sa pangkat',
    avuFeesExcluded:
      'Hindi available ang mga mining fee para sa bahagi ng pagtatantiyang ito; subsidy ng minero lamang ang ginagamit ng mga input na iyon.',
    avuHashEstimated:
      'Nakabatay ang isang entry sa tinantiyang datos ng hardware.',
    avuSpotValue: 'Nagkakahalaga ng {avu} AVU ang isang pakyawang kWh',
    avuSpotStale: 'Hindi na-refresh: {age} na ang pinakabagong presyo.',
    avuSpotNotPositive:
      'Hindi higit sa zero ang average na pakyawang presyo, kaya wala itong inverse.',
    avuSpotNoData: 'Wala pang natatanggap na pakyawang presyo ng kuryente.',
    avuUnitValue: '1 AVU = 1 kWh',
    avuNoPrice:
      'Walang presyo ang oracle para sa coin na ito, kaya wala itong AVU value.',
    avuTestnetValue: '{rate} · testnet',
    chartGridAvu: 'Isang kWh ng pakyawang kuryente (AVU)',
    chartNoteLines:
      '{count} punto mula {first}. Kinakalkula ang bawat isa para sa sarili nitong petsa gamit ang parehong pormula ng datos ngayon, mula sa mga presyo, estadistika ng chain, husay ng hardware at presyo ng kuryenteng umiiral noon. Walang punto kung may nawawalang input.',
    chartNoteNoTokenPrice:
      'Walang kasaysayan ng presyo para sa {symbol} sa saklaw na ito.',
    chartNoteEstimated:
      'Pagtatantiya ang husay ng hardware ng Monero bago ang unang ASIC (Setyembre 2023): isang desktop processor sa limitasyon ng package power nito, na hindi isinasama ang natitirang bahagi ng computer.',
    chartNoteTestnet:
      'Sinusukat ang halaga ng mga testnet coin ayon sa presyo ng mainnet coin.',
    chartNoteNoFeed:
      'Wala pang natatanggap mula sa oracle, kaya walang iginuhit.',
    sourcePrices: 'Mga presyo: {sources}.',
    sourceChains:
      'Difficulty, block reward at supply: {sources}. Ang difficulty ng Dogecoin ay ang datos nito sa 24 na oras.',
    sourceElectricity: 'Pakyawang kuryente: {sources}.',
    sourceGold:
      'Ginto: World Bank Commodity Price Data (Pink Sheet), taun-taon, na sinusukat sa AVU_hash ng kalagitnaan ng taon.',
    avuSpotRegionsLeftOut:
      'Hindi kasama sa datos na ito, dahil kulang ang kamakailang mga presyo: {regions}.',
    avuSpotRegionLast: '{region} (huling binilang noong {day})',
    avuHashVsSpotLess:
      'Mas mababa ng {percent}% ang bayad ng mining bawat kWh kaysa sa sinisingil ng grid.',
    avuHashVsSpotMore:
      'Mas mataas ng {percent}% ang bayad ng mining bawat kWh kaysa sa sinisingil ng grid.',
    sourceEcashShare:
      'Tumatanggap ang mga minero ng eCash ng {share} ng block reward mula noong {since} ({previous} dati), na binasa mula sa chain.',
    activeTokenCardTitle: '{symbol} sa AVU',
    inspectingDate: 'Sinusuri',
    latestValue: 'Pinakabago',
  },
  chatList: {
    senderPrefix: '{name}: {text}',
    noContactMessage: 'Magdagdag ng mga contact mula sa drawer sa itaas...',
    youPrefix: 'Ikaw: {text}',
    themPrefix: 'Sila: {text}',
    balance: 'Balanse',
    balanceStale: '(huling nalalaman)',
    directMessages: 'Mga Direktang Mensahe',
    composeEmail: 'Sumulat ng Email',
    openingConversation: 'Binubuksan ang pag-uusap…',
    selectChatOrAddContact:
      'Pumili ng pag-uusap o magdagdag ng contact upang magsimulang magmensahe.',
    searchPlaceholder: 'Maghanap sa mga mensahe, paksa, contact… (⌘K)',
    clearSearch: 'Burahin ang paghahanap',
    noSearchResults: 'Walang natagpuang katugmang mensahe o pag-uusap.',
    screenerFilterLabel: 'Tagasala ({count}) · {value}',
    screenerFilterEmpty:
      'Walang naghihintay na bayad na kahilingan mula sa di-kakilala.',
    allConversationsFilter: 'Lahat',
    screenerBannerTitle:
      'Tagasala ng Tollbooth: Nagbayad ang nagpadala ng {value} sa mga stamp upang makontak ka',
    screenerApprove: 'Aprubahan at Idagdag sa Mga Contact',
    screenerReplyOnce: 'Sumagot nang Isang Beses',
    screenerDismissKeepStamp: 'Isara at Panatilihin ang Stamp',
  },
  selfChat: {
    you: 'Ikaw',
  },
  outgoing: {
    sending: 'Ipinapadala…',
    paymentPending:
      'Nakabinbin ang bayad, susubukang muli. Hindi ka sisingilin muli.',
    paymentQueued:
      'Hinihintay matapos ang naunang mensahe. Ipapadala ito pagkatapos niyon.',
    paymentChecking: 'Sinusuri ang katayuan ng bayad…',
    waitingForPreviousPayment: 'Hinihintay makumpirma ang naunang bayad…',
    waitingForChain: 'Nakapila: hindi makontak ang network.',
    waitingBlocks:
      'Naghihintay ng {blocks} pang block matapos ang naunang bayad bago magbayad…',
    paymentSent: 'Naipadala',
    paymentInMempool: 'Nasa mempool ang stamp ng mensahe',
    paymentPaid: 'Nabayaran ang stamp',
    paymentReverted: 'Na-revert ang stamp ng mensahe, nagbabayad muli',
    paymentRepaid: 'Na-revert ang stamp, binayaran muli',
    paymentFailed: 'Nabigo ang stamp ng mensahe',
    paymentUnsent: 'Hindi nabayaran ang stamp ng mensahe',
    reasonUnreachable: 'Hindi makontak ang server.',
    reasonUnavailable: 'Walang pagmemensahe sa relay na ito.',
    reasonRejected: 'Tinanggihan ito ng relay.',
    reasonInterrupted: 'Naantala ito bago naipadala.',
    reasonUnverified: 'Hindi makumpirma ang paghahatid.',
    reasonRecovered: 'Naihatid ang isang naunang mensahe samantala.',
    reasonInsufficientFunds:
      'Hindi sapat ang pondo upang maipadala ang mensaheng ito.',
    reasonRecipientUnregistered:
      'Hindi nakarehistro ang tatanggap sa relay na ito.',
    reasonStampBelowFee:
      'Tumaas ang bayarin sa network nang higit sa stamp na ito bago ito naipadala. Walang nabayaran. Ipapadala ito ng Subukang muli gamit ang minimum na stamp sa ngayon.',
    reasonError: 'Hindi maipadala ang mensahe.',
    retry: 'Subukang muli',
    retryHint:
      'Ipinapadala muli ng Subukang muli ang parehong bayad habang balido pa ito. Gumagawa lamang ng bagong bayad kung hindi na ito balido.',
    discard: 'Itapon',
    discardConfirmTitle: 'Itapon ang mensahe?',
    discardConfirmMessage:
      'Aalisin nito ang mensahe sa pag-uusap mo. Kung nakabinbin pa ang bayad nito, maaari pa rin itong maihatid.',
    discardFailedConfirmMessage:
      'Aalisin nito ang nabigong mensahe sa pag-uusap mo. Walang pondong nagastos.',
    sendAgainTitle: 'Ipadala muli?',
    sendAgainUnverified:
      'Hindi namin makumpirma kung naihatid ang unang bayad. Maaaring masingil ka sa ikalawang pagkakataon kung magpapadala muli.',
    sendAgainRecovered:
      'Naihatid ang isang naunang nakabinbing mensahe habang ipinapadala ito. Ipadala itong muli bilang bagong mensahe?',
    sendAgain: 'Ipadala muli',
  },
  mailboxStatus: {
    directory: {
      'device-clock':
        'Naka-off ang pagmemensahe: mukhang mali ang petsa at oras ng device na ito. Suriin ang orasan; sinusubukang muli.',
      'account-unavailable':
        'Naka-off ang pagmemensahe: hindi mabuksan ang account na ito para sa pagmemensahe. Sinusubukang muli.',
      'relay-unreachable':
        'Naka-off ang pagmemensahe: hindi makontak ang server upang ilathala ang account mo. Sinusubukang muli.',
      'relay-rejected':
        'Naka-off ang pagmemensahe: tumanggi ang server na iimbak ang address entry ng account mo. Sinusubukang muli.',
      'relay-misconfigured':
        'Naka-off ang pagmemensahe: hindi wastong inilarawan ng server ang sarili nito, kaya hindi mailathala ang account mo. Sinusubukang muli.',
      'entry-refused':
        'Naka-off ang pagmemensahe: may salungat o hindi balidong entry ang server para sa account mo. Sinusubukang muli.',
      'storage':
        'Naka-off ang pagmemensahe: hindi ma-save ng device na ito ang mga rekord ng address book nito. Sinusubukang muli.',
    },
    unavailable:
      'Hindi available ang serbisyo sa pagmemensahe: walang pagmemensahe sa relay na ito, kaya hindi ka makatatanggap ng mga mensahe.',
    unreachable:
      'Hindi makontak ang server. Maaaring hindi ka nakatatanggap ng mga mensahe; sinusubukang muli.',
    rateLimited:
      'Hiniling ng server na magdahan-dahan kami. Susubukang muli maya-maya.',
    unauthorized:
      'Tinanggihan ng server ang iyong pag-log in para sa pagmemensahe. Sinusubukang muli.',
  },
  chatMessage: {
    notInContacts: 'Wala sa mga contact mo',
    openSender: 'Buksan ang profile ni {name}',
    noPayloadFound: 'Hindi mahanap ang payload ng mensahe',
    failedToSend: 'Nabigong maipadala',
    showActions: 'Ipakita ang mga aksyon sa mensahe',
    replyMessage: 'Sagutin ang mensahe',
    forwardMessage: 'Ipasa ang mensahe',
    infoMessage: 'Impormasyon ng mensahe',
    deleteMessage: 'Burahin ang mensahe',
  },
  chatMessageMenu: {
    reply: 'Sumagot',
    forward: 'Ipasa',
    copy: 'Kopyahin ang Teksto',
    stampTransaction: 'Transaksyon ng Stamp',
    resend: 'Ipadala muli',
    discard: 'Itapon',
    delete: 'Burahin',
    messageCopied: 'Nakopya ang mensahe sa clipboard',
  },
  chatListMenu: {
    openChat: 'Buksan ang Chat',
    viewProfile: 'Tingnan ang Profile',
    copyAddress: 'Kopyahin ang Address',
    mute: 'I-mute ang Mga Abiso',
    unmute: 'I-unmute ang Mga Abiso',
    deleteChat: 'Burahin ang Pag-uusap',
  },
  notifications: {
    addressCopied: 'Nakopya ang address sa clipboard.',
    insufficientStamp:
      'Masyadong maliit ang stamp, hindi maaabisuhan ang tatanggap.',
    seedCopied: 'Nakopya ang recovery phrase mo sa clipboard.',
    sentTransaction: 'Naipadalang transaksyon',
    unexpectedError: 'May nangyaring mali. Subukang muli.',
    viewAction: 'Tingnan',
  },
  chatRightDrawer: {
    deleteContactAndConversations: 'Burahin ang Contact at Mga Pag-uusap',
    stampPrice: 'Presyo ng Stamp',
    sendLotus: 'Magpadala ng Lotus',
    notifications: 'Mga Abiso',
    clearHistory: 'Burahin ang Kasaysayan',
    deleteChat: 'Burahin ang Chat',
    unknownContact: 'Hindi kilala',
    usernameReassigned:
      'Idinagdag mo ang contact na ito bilang {username}. Hawak na ngayon ng ibang account ang username na iyon. Ang contact na ito ay ang account pa ring idinagdag mo, at dito pa rin napupunta ang mga mensahe mo.',
  },
  sendStealthDialog: {
    nativeBalance: 'Native na balanse',
    insufficientFunds:
      'Hindi sapat ang asset o native na balanse para sa bayad na ito at bayarin sa network nito.',
    insufficientBalance: 'Higit ang halaga sa available na balanse',
    assetLabel: 'Asset at network',
    reviewBtnLabel: 'Suriin ang bayad',
    checkingQuote: 'Sinusuri ang mga balanse at bayarin…',
    recipientAmount: 'Halaga para sa tatanggap',
    nativeFee: 'Bayarin sa network',
    feeCeiling: 'Pinakamataas na bayarin sa network',
    messageStampFee: 'Tinatantiyang bayarin sa network ng mensahe',
    messageStamp: 'Stamp ng mensahe',
    preparing: 'Inihahanda ang stealth na bayad: {amount}',
    sendStealthTo: 'Magpadala ng Stealth na Bayad kay',
    subtitle:
      'Binabayaran mula sa wallet mo sa isang minsanang address na ang contact na ito lamang ang makagagastos',
    balanceLabel: 'Available para sa bayad na ito:',
    amountHint: 'Halagang babayaran',
    amountPlaceholder: '0.0',
    memoHint: 'Tala, kasama ng bayad (opsyonal)',
    memoPlaceholder: 'Maglagay ng tala...',
    sendBtnLabel: 'Ipadala',
    cancelBtnLabel: 'Kanselahin',
    sent: 'Naipadala ang bayad',
    pending:
      'Na-save ang bayad. Inihahatid pa ang mensahe nito; mababayaran ito kapag dumating ang mensahe. Huwag itong ipadala muli.',
    notSent: 'Hindi maisagawa ang pagbabayad. Walang ipinadala.',
    messageEnded:
      'Na-save ang bayad, at hindi maihatid ang mensahe nito. Buksan ang chat sa contact na ito at subukang muli ang mensahe: wala pang nabayaran, at walang mababayaran nang dalawang beses.',
    tooLarge:
      'Mas malaki ang bayad na ito kaysa sa kayang dalhin ng isang bayad sa contact (humigit-kumulang {max} {unit}); hati-hatiin ang pagpapadala.',
  },
  offerSwapDialog: {
    title: 'Mag-alok ng Atomic Swap kay',
    subtitle:
      'Atomic na palitan sa magkaibang chain nang hindi kailangang magtiwala sa kabilang panig',
    youPay: 'Iniaalok mo (babayaran)',
    youReceive: 'Matatanggap mo',
    offeredChain: 'Iniaalok na chain',
    requestedChain: 'Hinihiling na chain',
    offerBtnLabel: 'Mag-alok ng Swap',
    cancelBtnLabel: 'Kanselahin',
  },
  chatMessageSwap: {
    notAvailableYet:
      'Hindi pa available ang mga atomic swap. Walang maaaring i-lock, i-claim o i-refund mula rito.',
    title: 'Alok na Atomic Swap',
    offered: 'Inialok',
    for: 'Kapalit ng',
    accept: 'Tanggapin ang Swap',
    cancel: 'Kanselahin ang Alok',
    lockDeposit: 'Ideposito at I-lock ang {amount} {asset}',
    acceptAndLock: 'Tanggapin at I-lock ang {amount} {asset}',
    claimFunds: 'I-claim ang {amount} {asset}',
    refundDeposit: 'I-refund ang Deposito',
    activeOnOtherDevice: 'Aktibo sa {device}',
    takeOverActive: 'Gamitin dito',
    viewTx: 'Tingnan ang {chain} Tx',
    statusUnfunded: 'Walang pondo',
    statusLocked: 'Naka-lock sa Escrow',
    statusWithdrawn: 'Na-withdraw',
    statusRefunded: 'Na-refund',
    statusExpired: 'Nag-expire',
    processing: 'Pinoproseso...',
  },
  balanceBreakdown: {
    open: 'Kung nasaan ang balanseng ito',
    main: 'Pangunahing account',
    mainNote: 'Ang deposit address mo: ang ipinapakita sa ibaba.',
    profile: 'Address ng profile',
    profileNote: 'Ipinadala sa address sa profile mo.',
    received: 'Mga natanggap na bayad ({count})',
    receivedNote:
      'Mga bayad at stamp na ipinadala sa iyo, bawat isa sa sariling minsanang address nito, na nakumpirma sa network.',
    other: 'Mga account sa pagpapadala',
    otherNote:
      'Inilalaan ng wallet sa sarili nitong mga account upang bayaran ang susunod mong mga mensahe. Bahagi ng balanse sa itaas.',
    total: 'Balanse',
    yours:
      'Lahat ng account na ito ay pag-aari ng wallet na ito at naibabalik mula sa recovery phrase mo.',
    unavailable: 'Hindi mabasa ang mga account sa ngayon.',
  },
  heldContactPayments: {
    title: 'Mga kasalukuyang pagbabayad sa mga contact',
    finish: 'Tapusin',
    state: {
      prepared:
        'Napirmahan. Hinihintay maihatid ang mensahe nito; nakalaan ang pondo nito.',
      delivered: 'Naihatid ang mensahe. Papunta na sa chain ang bayad.',
      failed:
        'Hindi maihatid ang mensahe nito. Nakatago ang bayad; nakalaan ang pondo nito.',
    },
  },
  chatMessageStealth: {
    outboundState: {
      unknown: 'Hindi pa nasuri',
      planned: 'Inihahanda',
      prepared: 'Nakabinbin',
      delivered: 'Nakabinbin',
      paid: 'Nabayaran',
      failed: 'Nabigo ang paghahatid ng paglilipat',
      released: 'Kinansela bago ipadala',
    },
    title: 'Stealth na Bayad',
    sentTitle: 'Naipadalang Stealth na Bayad',
    receivedTitle: 'Natanggap na Stealth na Bayad',
    viewInExplorer: 'Tingnan ang transaksyon sa block explorer',
    viewTransaction: 'Tingnan ang transaksyon',
    sent: 'Naipadala',
    pending: 'Nakabinbin',
    received: 'Natanggap',
    unverified: 'Hindi pa nasuri',
    pendingHint:
      'Hinihintay ipakita ng chain ang bayad na ito. Wala pa ito sa balanse mo.',
    spendableHint: 'Kasama sa balanseng maaari mong gastusin',
    spentHint: 'Natanggap, at nagastos na mula noon',
    unverifiedHint: 'Hindi pa sinuri ng wallet mo ang bayad na ito sa chain.',
    statedAmount:
      '{stated} ang sinabi ng nagpadala; {actual} ang ipinapakita ng chain.',
    notReceived: 'Hindi natanggap ang bayad',
    notReceivedHint:
      'Inangkin ng nagpadala ang bayad na ito, at walang ganitong paglilipat na ipinapakita ang chain. Wala ito sa balanse mo. Patuloy itong sinusuri ng wallet mo.',
    failed: 'Nabigo ang bayad',
    failedHint:
      'Hindi na kailanman darating ang bayad na ito: nabigo o napalitan ang transaksyon nito. Wala ito sa balanse mo.',
    claimedAmount: 'inaangkin',
    notReceivedNotice:
      'Hindi dumating ang bayad na inaangkin ng nagpadala ({amount}).',
  },
  setup: {
    loginOrSignUp: 'Mag-log In/Mag-sign Up',
    welcome: 'Maligayang pagdating',
    welcomeToStampChat: 'Maligayang pagdating sa Frank!',
    networkTitle: 'Monad Testnet',
    testnetDisclaimer:
      'Tumatakbo ang Frank sa Monad testnet. Testnet MON ang gamit ng lahat ng transaksyon, na walang tunay na halagang pananalapi. Huwag kailanman magpadala ng tunay na pondo o mainnet na asset.',
    economicModelTitle: 'Mga Bayad na Aksyon at Gastos',
    costsDisclaimer:
      'May gastos sa network at stamp ang mga palabas na aksyon. Laging ipinapakita ang aktuwal na bayarin o halaga ng stamp bago mo kumpirmahin ang isang aksyon.',
    directMessagesTitle: 'Mga Direktang Mensahe',
    directMessagesDesc:
      'Direktang binabayaran sa tatanggap bilang stamp sa inbox, upang pigilan ang spam at bayaran ang paghahatid.',
    topicActionsTitle: 'Mga Post at Boto sa Forum',
    topicActionsDesc:
      'Sinusunog (permanenteng sinisira sa chain) upang maglathala ng mga pampublikong post sa paksa o magtala ng mga boto.',
    fundingTitle: 'Pagpopondo sa Testnet',
    fundingDesc:
      'Awtomatikong tumatanggap ng testnet MON ang mga bagong account mula sa demo faucet. Maaari mo ring tingnan ang address mo at kumuha ng testnet na pondo mula sa screen ng Pagtanggap matapos ang setup.',
    eulaDisclaimer:
      'Eksperimental na software ang Frank. Maaaring may mga bug itong magpaantala ng mga mensahe o magdulot ng pagkawala ng pondo. Gumamit lamang ng halagang kaya mong mawala.',
    eulaYouUnderstand:
      'Sa pag-click sa "Sumang-ayon", kinikilala mong ibinibigay ang Frank "kung ano ito", nang walang anumang warranty, hayag man o ipinahiwatig.',
    setupWallet: 'Setup ng Karakter',
    eula: 'EULA',
    deposit: 'Magdeposito ng Lotus',
    settings: 'Mga Setting',
    back: 'Bumalik',
    seedWarning:
      'Isulat ang recovery phrase mo at ingatan ito. Kapag nawala ito, walang sinumang makababawi ng account mo.',
    searchingRelay: 'Naghahanap ng kasalukuyang data sa relay...',
    networkErrorRelayDied:
      'Error sa Network: Naputol ang koneksyon sa relay server. ',
    networkErrorRelayUnexpected:
      'Error sa network: Nagkaroon ng di-inaasahang error ang relay.',
    requestingPayment: 'Humihiling ng Bayad...',
    sendingPayment: 'Ipinapadala ang Bayad...',
    uploadingMetaData: 'Ina-upload ang Metadata...',
    openingInbox: 'Binubuksan ang Inbox...',
    profileImageLargeError:
      'Masyadong malaki ang larawan sa profile, pumili ng mas maliit na larawan.',
    continue: 'Magpatuloy',
    finish: 'Tapusin',
    generatingWallet: 'Ginagawa ang wallet...',
    gatheringBalances: 'Kinakalap ang mga balanse...',
    watchingWallet: 'Minomonitor ang wallet...',
    searchingExistingMetaData:
      'Naghahanap ng kasalukuyang metadata sa registry...',
    errorContactRegistry: 'Hindi makontak ang registry',
    storedSeedMismatch:
      'Hindi mapapalitan mula sa screen na ito ang recovery phrase sa device na ito.',
    replaceNotAcknowledged:
      'Hindi mapapalitan ang account na ito nang hindi kinukumpirma ang pagpapalit.',
    accountSetupNext: 'Susunod',
    depositStepNext: 'Susunod',
  },
  accountStep: {
    newAccount: 'Bagong Account',
    importAccount: 'Mag-import ng Account',
    copyRecoveryPhrase: 'Kopyahin ang recovery phrase',
    refreshRecoveryPhrase: 'Gumawa ng bagong recovery phrase',
    resumeNotice:
      'May recovery phrase nang nakaimbak sa device na ito, ngunit wala pang pangalan ang account na ito. Kumpirmahin ito at pumili ng pangalan upang matapos. Hindi ito mapapalitan maliban kung mag-import ka ng ibang phrase na mayroon ka na.',
    confirmStoredFirst:
      'Kumpirmahin o kopyahin muna ang nakaimbak mong recovery phrase.',
    importDifferentPhrase: 'Mayroon na akong ibang recovery phrase',
    importDifferentContinue: 'Magpatuloy sa pag-import',
    invalidWordCount:
      'Dapat may 12, 15, 18, 21, o 24 salita ang recovery phrase.',
    unrecognizedWords:
      'Hindi kinikilala ang isa o higit pang salita. Suriin kung may maling pagkakatipa.',
    invalidChecksum:
      'Hindi balido ang checksum ng recovery phrase. Suriin ang ayos at baybay ng mga salita mo.',
  },
  seedConfirm: {
    unavailable:
      'Hindi available ang pagkumpirma dahil walang ligtas na random number generator ang device na ito. Bumalik at subukang muli, o gumamit ng ibang browser.',
    stepTitle: 'Kumpirmahin ang phrase',
    title: 'Kumpirmahin ang recovery phrase mo',
    instructions:
      'Ilagay ang hinihiling na mga salita mula sa recovery phrase na isinulat mo. Gagawin lamang ang account mo kapag tumugma ang mga ito.',
    wordLabel: 'Salita #{n}',
    check: 'Suriin ang mga sagot ko',
    wordError: 'Hindi tumutugma ang salita #{n}',
    recheck:
      'May mga salitang hindi tumutugma sa recovery phrase mo. Suriin muli ang mga salitang may bilang na ito: {positions}.',
    success: 'Nakumpirma ang recovery phrase. Maaari mong tapusin ang setup.',
    showPhrase: 'Ipakita muli ang recovery phrase ko',
    hidePhrase: 'Itago ang recovery phrase ko',
    phraseLabel: 'Ang recovery phrase mo, ayon sa pagkakasunod-sunod',
  },
  backupReminder: {
    regionLabel: 'Paalala sa backup ng recovery phrase',
    message:
      'Hindi mo pa nakumpirma ang recovery phrase mo. Kumpirmahing na-save mo ito upang lagi mong mabawi ang account mo.',
    confirm: 'Kumpirmahin ngayon',
    dismiss: 'Mamaya',
  },
  replaceGuard: {
    title: 'May account ka na sa device na ito',
    intro:
      'Mapapalitan ito kapag nag-setup muli. Ang recovery phrase mo ang tanging paraan upang maibalik ang account na ito at ang pondo nito.',
    introNameOnly:
      'Mapapalitan ito kapag nag-setup muli. Walang recovery phrase o pondo sa wallet ang profile na ito sa device na ito.',
    confirmed: 'Nakumpirma ang kasalukuyan mong recovery phrase.',
    cancel: 'Kanselahin at bumalik sa account ko',
    confirmCurrent: 'Kumpirmahin ang kasalukuyan kong recovery phrase',
    replaceToggle: 'Palitan ang account na ito',
    warning:
      'Aalisin sa device na ito ang kasalukuyan mong recovery phrase, pangalan at profile kapag pinalitan ang account. Kung hindi mo na-back up ang phrase, maaaring hindi na mabawi ang account at anumang pondo.',
    warningNameOnly:
      'Aalisin sa device na ito ang kasalukuyan mong pangalan at profile kapag pinalitan ang account.',
    typeLabel: 'I-type ang {word} upang magpatuloy',
    word: 'PALITAN',
    mismatch:
      'Hindi iyan tumutugma. I-type nang eksakto ang salita upang magpatuloy.',
    replace: 'Palitan ang account na ito',
  },
  newContactDialog: {
    lookup: {
      'clock':
        'Mukhang mali ang petsa at oras ng device na ito, kaya hindi masuri ang address na ito. Suriin ang orasan at subukang muli.',
      'not-published':
        'Hindi pa nailathala ng address na ito ang sarili nito, kaya hindi ito makatatanggap ng mga mensahe. Hilingin sa may-ari na buksan ang app nang isang beses.',
      'unreachable':
        'Hindi makontak ang server upang hanapin ang address na ito. Subukang muli maya-maya.',
      'refused':
        'Nagbalik ang server ng entry para sa address na ito na hindi nito pinirmahan, nag-expire na o salungat sa dati nang nakita. Hindi ito ginamit.',
      'messaging-off':
        'Inilalathala pa ang sarili mong account. Makapagdaragdag ka ng mga contact kapag naka-on na ang pagmemensahe.',
    },
    newContact: 'Bagong Contact',
    startConversation: 'Magsimula ng Pag-uusap',
    startConversationBtn: 'Magsimula ng Pag-uusap',
    addContact: 'Magdagdag ng Contact',
    addAndChat: 'Idagdag at Mag-chat',
    contactAdded: 'Naidagdag ang contact',
    composeEmail: 'Sumulat ng Email',
    enterBitcoinCashAddress: 'Maglagay ng address (0x...) o email address',
    enterAddress: 'Maglagay ng address (0x...) o email address',
    enterAddressOrEmail:
      'Maglagay ng address (0x...), pangalan ng contact, username, o email',
    existingContacts: 'Mga Kasalukuyang Contact',
    existingContact: 'Kasalukuyang Contact',
    clearContact: 'Alisin ang contact',
    topicOptional: 'Paksa (opsyonal)',
    topicPlaceholder: 'hal. pagpaplano-ng-proyekto, tanong, invoice',
    loading: 'Hinahanap ang contact',
    notFound: 'Hindi Natagpuan',
    found: 'Nahanap na contact: {name}',
    ownAddress:
      'Sarili mong address ito. Hindi mo maaaring idagdag ang sarili mo bilang contact.',
    showMyQr: 'Ipakita ang QR Code Ko',
    startEmail: 'Magsimula ng Email',
    startEmailThread:
      'Magsimula ng Usapan sa Email kay {email} (sa pamamagitan ng Frank Email Gateway)',
    startEmailThreadAffordance:
      'Magsimula ng Usapan sa Email kay {email} (sa pamamagitan ng Frank Email Gateway)',
    sendEmailViaGateway:
      'Sumulat at magpadala ng palabas na email sa pamamagitan ng Frank Email Gateway',
  },
  emailThread: {
    gatewayBadge: '✉️ Email Bridge (sa pamamagitan ng Frank Gateway)',
    unverifiedBadge: '⚠️ Direktang P2P Email (Hindi Naverify)',
    collapseAll: 'Tiklupin Lahat',
    expandAll: 'Palawakin Lahat',
    participants: 'Mga Kalahok',
    messageSingle: 'mensahe',
    messagePlural: 'mga mensahe',
    to: 'Para kay',
    cc: 'Cc',
    bcc: 'Bcc',
    attachmentsCount: 'Mga Attachment ({count}):',
    attachFiles: 'Mag-attach ng mga file',
    reply: 'Sumagot',
    replyAll: 'Sagutin Lahat',
    replySender: 'Sagutin ang Nagpadala',
    hideCc: '- CC',
    showCc: '+ CC',
    hideBcc: '- BCC',
    showBcc: '+ BCC',
    addRecipient: 'Magdagdag ng tatanggap...',
    addCcRecipient: 'Magdagdag ng tatanggap sa Cc...',
    addBccRecipient: 'Magdagdag ng tatanggap sa Bcc...',
    subjectLabel: 'Paksa:',
    subjectPlaceholder: 'Paksa',
    writeMessagePlaceholder: 'Isulat ang mensahe ng email mo...',
    writeReplyPlaceholder: 'Isulat ang sagot mo sa email...',
    quoteOriginal: 'Sipiin ang Orihinal',
    preview: 'Silipin',
    edit: 'I-edit',
    send: 'Ipadala',
    sendTooltip: 'Ipadala sa pamamagitan ng Frank Email Gateway (Ctrl+Enter)',
    newDraftTitle: 'Bagong Usapan sa Email',
    newDraftSubtitle:
      'Isulat ang mensahe mo sa ibaba. Ihahatid ito ng Frank sa tatanggap sa pamamagitan ng Frank Email Gateway gamit ang karaniwang Internet email.',
    newEmail: 'Bagong Palabas na Email',
    followUp: 'Draft na Follow-up',
    stampExplanation:
      'Inihahatid sa pamamagitan ng Frank Email Gateway. Binabayaran ng stamp ang pagpapadala ng gateway at patunay laban sa spam.',
    formatBold: 'Makapal',
    formatItalic: 'Nakahilig',
    formatHeading: 'Pamagat',
    formatQuote: 'Sipi',
    formatCode: 'Code',
    formatBullet: 'Listahang may Bullet',
    formatLink: 'Link',
    showQuotedText: 'Ipakita ang siniping teksto',
    hideQuotedText: 'Itago ang siniping teksto',
  },
  newTopicDialog: {
    newTopic: 'Magdagdag ng Paksa',
    enterTopic: 'Maglagay ng paksa...',
    topicNameMinLength: 'Gumamit ng hindi bababa sa 3 character',
    topicNameRules:
      'A-Z, a-z, 0-9, at mga tuldok lamang ang balidong character',
    add: 'Idagdag',
    cancel: 'Kanselahin',
  },
  topicDrawer: {
    offering: 'Iniaalok:',
    filter: 'Filter:',
  },
  SettingPanel: {
    newContact: 'Bagong Contact',
    contacts: 'Mga Contact',
    sendMonad: 'Magpadala ng MON',
    receiveMonad: 'Tumanggap ng MON',
    profile: 'Profile',
    settings: 'Mga Setting',
    changeLog: 'Talaan ng mga Pagbabago',
    showSeed: 'Ipakita ang Seed',
    confirmSeed: 'Kumpirmahin ang Recovery Phrase',
    panelLabel: 'Mga Setting',
  },
  receiveBitcoinDialog: {
    walletStatus: 'Katayuan ng Wallet',
    balanceUnavailable: 'Hindi available ang balanse. Sinusubukang muli.',
    noFundsHint:
      '0 ang balanse mo. Gumagamit ang app na ito ng testnet MON, na walang tunay na halaga. Awtomatikong pinopondohan ng demo faucet ang mga bagong profile; kung walang dumating pagkalipas ng isang minuto, hilingin sa demo operator na magpadala ng testnet MON sa address sa ibaba.',
    close: 'Isara',
    addressCopied: 'Nakopya ang address sa clipboard',
    failedLoadBalance: 'Hindi mai-load ang balanse ng wallet',
    unableCopyAddress: 'Hindi makopya ang Monad address',
  },
  walletHistory: {
    transfers: 'Mga Paglipat',
    to: 'Para kay',
    contract: 'Kontrata',
    details: 'Mga Detalye',
    intended: 'Ito ang halagang hiniling. Hindi pa nakumpirma ang buong bayad.',
    dateUnknown: 'Hindi naitala ang petsa para sa paglilipat na ito.',
    transaction: 'Transaksyon {number}',
    status: {
      confirmed: 'Nakumpirma',
      included: 'Naipadala',
      reverted: 'Na-revert',
      partial: 'Bahagyang naproseso',
      pending: 'Nakabinbin',
      missing: 'Hinihintay ang network',
      unknown: 'Sinusuri ang bayad',
      cancelled: 'Kinansela',
    },
    memberStatus: {
      'included-success': 'Nakumpirma',
      'included-revert': 'Na-revert',
      'pending': 'Nakabinbin',
      'missing': 'Wala pa sa network',
      'unknown': 'Hindi nakumpirma',
    },
  },
  nativeOperation: {
    title: 'Resulta ng paglilipat',
    listTitle: 'Mga native na paglilipat',
    intendedAmount: 'Nilalayong halaga para sa tatanggap',
    processing: 'Sinusuri ang resulta ng orihinal na paglilipat…',
    included: 'Naipadala sa {network}.',
    reverted:
      'Na-revert ang transaksyon ng tatanggap sa {network}. Maaaring may nabayarang mga bayarin sa network.',
    partial:
      'Kasama sa {network} ang ilang transaksyon sa pagpopondo; hindi naitalang kasama ang bayad sa tatanggap.',
    pending: 'Nasa mempool sa {network}: naipadala, naghihintay ng block.',
    missing: 'Wala pa sa {network} ang paglilipat na ito. Iniaalok itong muli.',
    watching:
      'Minomonitor ang network. Kusa itong nag-a-update kapag nasa block na ang paglilipat.',
    unknown:
      'Hindi pa nalulutas ang resulta ng bayad sa {network}. Maaaring nailipat na ang pondo.',
    cancelled: 'Kinansela ang hindi pa napipirmahang paglilipat.',
    feecomplete: 'Naobserbahang mga bayarin sa network: {amount} {unit}',
    feepartial:
      'Naobserbahang mga bayarin sa ngayon (bahagya): {amount} {unit}',
    feeunknown: 'Hindi available ang naobserbahang mga bayarin sa network.',
    block: 'Block {block}',
    syncNotShared: 'Hindi pa naibabahagi sa iba mong device.',
    syncShared: 'Naipadala sa iba mong device.',
    syncFailed:
      'Hindi pa maipadala sa iba mong device. Susubukan itong muli; hindi naaapektuhan ang bayad mo.',
    recoveryUnavailable: 'Hindi available ang pagbawi sa ngayon.',
    reviewHeld: 'Hindi makapagpapadala ng ibang bayad ang pagsusuring ito.',
    unsupported:
      'Hindi available ang kasaysayan ng native na paglilipat para sa wallet na ito.',
    unavailable: 'Hindi available ang ebidensya ng native na paglilipat.',
    empty: 'Walang nakatagong native na paglilipat.',
    viewTransfer: 'Tingnan ang paglilipat',
    contractCall: 'Pagtawag sa kontrata (isang swap o pag-apruba nito)',
    back: 'Bumalik',
    stale:
      'Nagbago ang account o pahina. Tingnan ang orihinal na paglilipat mula sa wallet nito.',
  },
  sendAddressDialog: {
    sendToAddress: 'Magpadala sa Address',
    enterBitcoinCashAddress: 'Maglagay ng address (0x...)',
    enterAmount: 'Maglagay ng Halaga ({unit})',
    cancel: 'Kanselahin',
    send: 'Ipadala',
    review: 'Suriin',
    reviewTitle: 'Suriin ang Paglilipat',
    network: 'Network',
    recipient: 'Tatanggap',
    amount: 'Halaga',
    estimatedFee: 'Tinatantiyang Bayarin',
    feeUnavailable: 'Hindi available',
    refused: 'Tinanggihan ng network ang transaksyong ito. Walang ipinadala.',
    feeChanged:
      'Tumaas ang bayarin sa network. Walang ipinadala. Suriin ang bagong bayarin at kumpirmahin muli.',
    maxTotal: 'Halaga + bayarin sa network',
    maxTotalWithFee: '{amount} {unit} (+ bayarin sa network)',
    irreversibleWarning:
      'Hindi na mababawi ang mga transaksyon sa blockchain. Iverify ang tatanggap at network bago kumpirmahin.',
    editTransfer: 'I-edit',
    confirmAndSend: 'Kumpirmahin at Ipadala',
    definitelyNotBroadcast:
      'Hindi na-broadcast ang transaksyon. Walang pondong nailipat.',
    potentiallyBroadcast:
      'Napirmahan ang transaksyon ({txHash}) at maaaring na-broadcast na. Suriin ang balanse o katayuan ng transaksyon bago subukang muli.',
    invalidTransfer: 'Maglagay ng balidong Monad address at halaga ng MON.',
    failedSendTransaction: 'Nabigong maipadala ang transaksyon sa Monad',
  },
  sendContactDialog: {
    available: 'Available para sa bayad na ito: {amount}',
    title: 'Magpadala sa Contact',
    selectContact: 'Pumili ng Contact',
    searchContacts: 'Maghanap ng mga contact...',
    selectedContact: 'Napiling Contact',
    changeContact: 'Baguhin',
    noContactsFound: 'Walang nahanap na contact',
    enterAmount: 'Maglagay ng halaga ({unit})',
    amount: 'Halaga',
    memo: 'Tala (opsyonal)',
    reviewTransfer: 'Suriin ang Paglilipat',
    recipient: 'Tatanggap',
    stealthNotice:
      'Binabayaran sa isang minsanang address na ang contact na ito lamang ang makagagastos. Ipinapaalam ng isang mensahe sa wallet nila kung nasaan ang pera.',
    confirmAndSend: 'Kumpirmahin at Ipadala',
    sending: 'Ipinapadala...',
    cancel: 'Kanselahin',
    back: 'Bumalik',
    edit: 'I-edit',
    invalidAmount: 'Maglagay ng balidong halaga',
    missingSpendKey: 'Walang nakarehistrong stealth public key ang contact',
    sent: 'Naipadala ang bayad',
    pending:
      'Na-save ang bayad. Inihahatid pa ang mensahe nito; mababayaran ito kapag dumating ang mensahe. Huwag itong ipadala muli.',
    notSent: 'Hindi maisagawa ang pagbabayad. Walang ipinadala.',
    messageEnded:
      'Na-save ang bayad, at hindi maihatid ang mensahe nito. Buksan ang chat sa contact na ito at subukang muli ang mensahe: wala pang nabayaran, at walang mababayaran nang dalawang beses.',
    tooLarge:
      'Mas malaki ang bayad na ito kaysa sa kayang dalhin ng isang bayad sa contact (humigit-kumulang {max} {unit}); hati-hatiin ang pagpapadala.',
  },
  contactBookDialog: {
    contacts: 'Mga Contact',
    search: 'Maghanap...',
    close: 'Isara',
    myQrCode: 'Ang Identity QR Code Ko',
  },
  contactItem: {
    address: 'Address',
    inboxPrice: 'Presyo ng Inbox',
    notFound: 'Hindi Natagpuan',
  },
  settings: {
    title: 'Mga Setting',
    back: 'Bumalik',
    openMenu: 'Buksan ang menu',
    appearance: 'Hitsura',
    networking: 'Mga Koneksyon',
    contactRefreshInterval: 'Pagitan ng Pag-refresh ng Contact (minuto)',
    contactRefreshIntervalHint: 'Pagitan ng mga pag-update ng contact (minuto)',
    darkMode: 'Dark Mode',
    themeTitle: 'Signet Theme Stone',
    saveSettings: 'I-save',
    savedNotification: 'Na-save ang mga setting',
    cancelSettings: 'Kanselahin',
    languageSelectorCaption: 'Wika',
    networkSettings: 'Mga Setting ng Network at Gateway',
    emailGatewayAddress: 'Address ng Email Gateway',
    emailGatewayFee:
      'Bayarin sa stamp ng papasok na email: 0.01 MONT. Binabayaran ng gateway ang pagpapadala at pagverify laban sa spam.',
    emailGatewayRelayLabel: 'Relay gateway:',
    emailGatewayChanged:
      'Nagbago ang relay o pagkakakilanlan ng email gateway nito. Suriin ang bagong address bago ito gamitin.',
    emailGatewayChecking: 'Sinusuri ang relay na ito para sa email gateway…',
    emailGatewayUnavailable:
      'Walang available na email gateway ang relay na ito. Hindi available ang pagpapadala ng email maliban kung magtakda ka ng tiyak na address.',
    emailGatewayOverrideHint:
      'Opsyonal na pamalit na address para sa napiling network',
    acceptRelayGateway: 'Tanggapin ang relay gateway',
    useRelayGateway: 'Gamitin ang relay gateway',
    resetDefault: 'Ibalik sa default',
    save: 'I-save',
    gateways: 'Mga Gateway',
    networkModeTitle: 'Kapaligiran ng Network at mga Chain',
    testnetMode: 'Testnet Mode',
    testnetActiveBanner:
      'Aktibo ang testnet sa Monad at lahat ng pangalawang settlement network.',
    mainnetActiveBanner:
      'Aktibo ang mainnet. Tunay na mga asset ang ginagamit sa mga transaksyon at settlement.',
    mainnetLockedBanner: 'Naka-lock muna ang paglipat sa mainnet.',
    supportedChainsTitle: 'Mga Suportadong Settlement Network',
    chainSendReceive: 'Magpadala at tumanggap',
    chainUnsupported: 'Hindi suportado',
    notificationFeeThresholdAvu: 'Minimum na Bayad para sa Abiso (AVU)',
    notificationFeeThresholdAvuHint:
      'Minimum na halaga ng stamp sa AVU (1 AVU = 1 kWh, hal. 0.01 AVU) na kailangan upang mag-trigger ng push notification (tahimik pa ring inihahatid sa inbox mo ang mga mensaheng mas mababa sa halagang ito)',
    allowContactNotificationBypass:
      'Payagan ang mga contact na may wakeup token na mag-abiso nang walang stamp',
    coldVaultTitle: 'Vault para sa Awtomatikong Paglipat sa Cold Wallet',
    coldVaultSubtitle:
      'Awtomatikong ilipat nang direkta (1-hop) ang mga papasok na stamp at bayad na lampas sa limitasyon ng hot wallet mo sa isang panlabas na MetaMask, Phantom, o Ledger vault address.',
    coldVaultEnabled: 'Paganahin ang Cold-Wallet Auto-Sweep',
    coldVaultAddressLabel: 'Address ng Panlabas na Vault (EVM / Solana)',
    coldVaultAddressHint:
      'Address ng hardware o browser wallet (0x... o Solana base58) na tatanggap ng inililipat na sobrang pondo',
    coldVaultMaxHotBalanceLabel:
      'Pinakamataas na Pondong Pananatiliin sa Hot Wallet (MON)',
    coldVaultMaxHotBalanceHint:
      'Default: 1,500 MON (~150 AVU, +20% hysteresis trigger sa 1,800 MON)',
    languageAutomatic: 'Awtomatiko (wika ng browser)',
  },
  profile: {
    name: 'Pangalang Ipapakita',
    seedEntry: 'Recovery phrase',
    importSeed: 'Ibalik ang mga nakaraang alaala',
    invalidSeed: 'Hindi balidong recovery phrase iyan.',
    nameHint: 'Pangalang ipinapakita sa iba',
    enterSeed: 'Ilagay ang recovery phrase mo...',
    nameBlank:
      'Maglagay ng pangalan: hindi ito maaaring walang laman o puro espasyo.',
    nameTooLong:
      'Masyadong mahaba ang pangalan: gumamit ng hanggang {max} character.',
    nameForbiddenCharacters:
      'May mga character sa pangalan na hindi pinapayagan. Alisin ang mga line break at iba pang control character.',
    nameInvalidUnicode:
      'May hindi balidong character sa pangalan. Burahin ito o mag-paste ng plain text.',
    bio: 'Talambuhay',
    bioHint: 'Maikling talambuhay na ipinapakita sa iba',
    uploadAvatar: 'Mag-upload ng Avatar',
    username: 'Username',
    usernameHint:
      'Natatanging handle (3–32 character, maliliit na titik, numero, gitling, underscore)',
    invalidUsername:
      'Dapat 3–32 character ang username at naglalaman lamang ng maliliit na titik, numero, gitling, at underscore.',
    usernameTaken: 'Ginagamit na ang username na iyan. Pumili ng iba.',
    usernameNotPublished:
      'Hindi pa nailathala ang account mo sa relay. Maghintay hanggang naka-on ang pagmemensahe, pagkatapos ay mag-save muli.',
    usernameUnavailable:
      'Hindi maitakda ang username: hindi makontak ang relay o tinanggihan nito ang kahilingan. Subukang muli.',
    usernameConfirmedTitle: 'Nakumpirma ng relay ang username',
    usernameNoWallet:
      'I-unlock ang account mo bago magtakda ng username: kailangan nitong pirmahan ang kahilingan.',
    usernameNotHeld:
      'Hindi hawak ng account na ito sa relay ang naka-save mong username. Buksan ang profile mo upang makita kung bakit.',
    usernameStillHeld:
      'Hawak ng account na ito ang {username}. Hindi maaaring bitawan ang username: sa iyo pa rin ito hanggang kumuha ka ng iba.',
    nameStartsWithAt:
      "Hindi maaaring magsimula sa {'@'} ang pangalan. Itakda ang username mo sa field ng Username.",
    location: 'Lokasyon',
    locationHint: 'Kung saan ka nakabase (opsyonal)',
    links: 'Mga Link at Social',
    addLink: 'Magdagdag ng Link',
    removeLink: 'Alisin ang link',
    linkType: 'Platform / Uri',
    linkUrl: 'URL o handle',
    linkLabel: 'Label (opsyonal)',
    linkTypeWebsite: 'Website / Blog',
    linkTypeX: 'X (Twitter)',
    linkTypeGithub: 'GitHub',
    linkTypeNostr: 'Nostr',
    linkTypeTelegram: 'Telegram',
    linkTypeDiscord: 'Discord',
    linkTypeOther: 'Iba pa',
    unnamed: 'Walang pangalan',
    accountType: 'Uri ng Account',
    accountTypeHint:
      'Ipahayag kung ang account na ito ay kumakatawan sa tao, bot, serbisyo, o organisasyon',
    accountTypePerson: 'Tao',
    accountTypeBot: 'Bot',
    accountTypeService: 'Serbisyo',
    accountTypeOrganization: 'Organisasyon',
    botRole: 'Tungkulin ng Bot / Serbisyo',
    botRoleHint: 'Espesyal na tungkulin para sa awtomatikong account na ito',
    botRoleGeneric: 'Pangkalahatan',
    botRoleAssistant: 'AI Assistant',
    botRoleFaucet: 'Faucet',
    botRoleGame: 'Tagahatol sa Laro / Dealer',
    botRoleBridge: 'Bridge',
    botRoleMerchant: 'Mangangalakal / Tindahan',
    botRoleModerator: 'Moderator',
    botRoleAnnouncer: 'Tagapag-anunsyo',
    badgeOfficial: 'Opisyal',
    badgeOfficialBot: 'Opisyal na Bot',
    badgeOfficialService: 'Opisyal na Serbisyo',
    badgeBot: 'Bot',
    badgeService: 'Serbisyo',
    badgeAi: 'Opisyal na AI',
    badgeFaucet: 'Opisyal na Faucet',
    badgeGame: 'Laro',
    badgeOfficialGame: 'Opisyal na Laro',
    badgeMerchant: 'Mangangalakal',
    badgeOfficialMerchant: 'Opisyal na Mangangalakal',
    badgeModerator: 'Moderator',
    badgeOfficialModerator: 'Opisyal na Moderator',
    badgeAnnouncer: 'Tagapag-anunsyo',
    badgeOfficialAnnouncer: 'Opisyal na Tagapag-anunsyo',
    badgeBridge: 'Bridge',
    badgeOfficialBridge: 'Opisyal na Bridge',
  },
  clearHistoryDialog: {
    cancel: 'Kanselahin',
    clear: 'Burahin',
    message:
      'Sigurado ka bang gusto mong burahin ang buong kasaysayan ng chat kay',
  },
  deleteContactDialog: {
    message: 'Burahin si {name} at lahat ng pag-uusap sa contact na ito?',
    cancel: 'Kanselahin',
    delete: 'Burahin ang Contact at Mga Pag-uusap',
    failed: 'Hindi matapos ang pagbubura ng contact na ito. Subukang muli.',
  },
  deleteChatDialog: {
    cancel: 'Kanselahin',
    delete: 'Burahin',
    message:
      'Sigurado ka bang gusto mong burahin ang buong kasaysayan ng chat kay',
  },
  deleteMessageDialog: {
    cancel: 'Kanselahin',
    delete: 'Burahin',
    message: 'Sigurado ka bang gusto mong burahin ang mensaheng ito?',
  },
  imageDialog: {
    close: 'Isara',
  },
  profileDialog: {
    accountChanged:
      'Nagbago ang account mo. Buksan muli ang profile bago mag-save.',
    cancel: 'Kanselahin',
    update: 'I-update',
    republish: 'Ilathala muli',
    avatarTooLarge:
      'Masyadong malaki ang avatar sa profile, pumili ng mas maliit na larawan.',
    unableContactRelay: 'Hindi makontak ang relay server.',
    pushingProfile: 'Ipinapadala ang bagong Profile...',
    profile: 'Profile',
    savedNotification: 'Na-update ang profile',
    identityQr: 'Pagkakakilanlan at QR',
    viewIdentityQr: 'QR para sa Pagbabahagi / Kaibigan',
    identityHeading: 'Ang Pagkakakilanlan Mo sa Frank',
    identitySubheading:
      'Ibahagi ang QR code o address na ito sa mga kaibigan upang maidagdag ka nila sa mga contact at mapadalhan ng mga naka-encrypt na mensahe.',
    identityAddressLabel:
      'Identity Address (para sa pagmemensahe at mga contact)',
    identityExplanation:
      'Inilalathala sa directory relay ang canonical na address na ito. Idinaragdag ng mga kaibigan ang address na ito upang magsimula ng end-to-end encrypted na direktang chat sa iyo.',
    receiveVsIdentityTitle: 'Identity Address at Address sa Pagtanggap',
    receiveVsIdentityBody:
      'Ginagamit ang Identity Address mo para sa mga contact, pagmemensahe, at pagpapakita ng profile sa forum. Upang tumanggap ng pondo, token, o gas, gamitin ang Address sa Pagtanggap mo.',
    receiveAddressHint:
      'Kailangan mo bang tumanggap ng mga coin o token? Pinamamahalaan sa Wallet mo ang Address sa Pagtanggap.',
    goToWallet: 'Pumunta sa Wallet',
    scanPrompt: 'I-scan upang idagdag bilang contact sa Frank',
  },
  seedPhraseDialog: {
    seedPhrase: 'Recovery Phrase',
    close: 'Isara',
    cancel: 'Kanselahin',
    warningTitle: 'Babala sa Seguridad',
    warningBody:
      'Siguraduhing walang nanonood ng screen mo. Mag-ingat sa screen-sharing, pagsilip sa likod mo, mga screenshot, at kasaysayan ng clipboard.',
    disclosureText:
      'Sinumang makakuha ng recovery phrase mo ay maaaring magkaroon ng access at permanenteng nakawin ang lahat ng pondo at mensahe mo.',
    revealButton: 'Ipakita ang Recovery Phrase',
    hideButton: 'Itago',
    copyButton: 'Kopyahin',
    copied: 'Nakopya!',
    copiedToast: 'Nakopya ang recovery phrase sa clipboard',
    keepPrivateNotice:
      'Panatilihin itong pribado. Huwag ibahagi o i-screenshot.',
  },
  transactionDialog: {
    stealthPayment: 'Stealth na bayad',
    valueUnavailable: 'Hindi available ang halaga ng transaksyon',
    transactionUnavailable: 'Hindi ma-decode ang transaksyon',
    baseUnits: 'mga batayang yunit',
    stampState: {
      pending: 'Naipadala',
      mempool: 'Nasa mempool',
      paid: 'Nabayaran',
      repaid: 'Binayaran muli',
      reverted: 'Na-revert',
      failed: 'Nabigo',
      unsent: 'Hindi nabayaran',
    },
    backingTransactions: 'Mga Sumusuportang Transaksyon',
    totalStampPayment: 'Kabuuang bayad sa stamp',
    stampPaymentN: 'Bayad sa stamp {n}',
    sentTo: 'Para sa {address}',
    txId: 'Transaction ID',
    txType: 'Uri',
    txAddress: 'Address',
    txAmount: 'Halaga',
    copyTxHash: 'Kopyahin ang transaction hash',
    localChainNotice: 'Lokal na stack / chain shim',
    txHashCopied: 'Nakopya ang transaction hash sa clipboard',
  },
  about: {
    appName: 'Frank',
    title: 'Tungkol',
    menu: 'Tungkol at mga lisensya',
    tagline:
      'Pribadong pagmemensaheng lumalaban sa spam sa pamamagitan ng gastos, para sa Monad.',
    checkForUpdates: 'Tingnan kung may update',
    checkingForUpdates: 'Naghahanap ng mga update…',
    alreadyLatestVersion: 'Gamit mo na ang pinakabagong bersyon.',
    reloadAndClearCache: 'I-reload at burahin ang cache',
    clearCacheConfirm:
      'Sigurado ka bang gusto mong burahin ang cache at mag-reload?',
    frankTitle: 'Tungkol sa Frank',
    frankIntro:
      'Ang Frank ay isang desentralisado at malayang cryptomessenger na dinisenyo para sa Monad blockchain, na nagpapatuloy at nagpapaunlad sa Stamp protocol. Pinagsasama nito ang mga cryptographic na pagkakakilanlang hindi kailangan ng pahintulot at tunay na paglaban sa spam sa pamamagitan ng gastos.',
    frankAccounts:
      'Ang mga account ay secp256k1 keypair na hindi kailangan ng pahintulot at buong ginagawa sa device mo. Hindi kailangan ng Frank ang mga numero ng telepono, email address, o sentral na provider ng account.',
    stampTitle: 'Ang Stamp Protocol: May Kapalit ang Malayang Pananalita',
    stampIntro:
      'Sa halip na umasa sa mga sentral na tagapagbantay o pagmamatyag upang salain ang spam, ipinapasok ng Stamp protocol ang direktang mga insentibong pang-ekonomiya sa komunikasyon.',
    stampDMsTitle: 'Mga Direktang Mensahe at Bayad na Paghahatid',
    stampDMsDesc:
      'May on-chain na transaksyon ng stamp ang bawat direktang mensahe na direktang nagbabayad sa tatanggap sa pamamagitan ng mga hinangong minsanang stealth na destinasyon. Nagbabayad ang mga nagpadala para sa atensyon mo, na lubos na nag-aalis ng spam mula sa di-kakilala.',
    stampTopicsTitle: 'Mga Broadcast sa Paksa at Timbang ng Pagsunog',
    stampTopicsDesc:
      'Nagsusunog ng MON sa isang address na hindi magagastos ang mga pampublikong post sa paksa at boto ng komunidad, na nagbibigay ng napapatunayang bigat na pang-ekonomiya sa pampublikong talakayan nang walang sentral na moderasyon.',
    stampPrivacyTitle: 'End-to-End Encryption',
    stampPrivacyDesc:
      'End-to-end encrypted ang lahat ng payload ng mensahe. Vineverify ng mga federated na CashWeb relay ang mga transaksyon ng stamp at iniimbak ang mga envelope nang hindi kailanman nakikita ang nababasang nilalaman.',
    badgeMonad: 'Monad',
    badgeStamp: 'Stamp Protocol',
    badgeEncrypted: 'End-to-End Encrypted',
    badgePermissionless: 'Pagkakakilanlang Hindi Kailangan ng Pahintulot',
    thirdPartyTitle: 'Software ng ibang partido',
    dklsName:
      'DKLs23 library para sa pagpirma ng dalawang panig (Silence Laboratories)',
    dklsModified:
      'May binagong bersyon ng DKLs23 library ng Silence Laboratories ang Frank. Binago ito ng proyektong Frank noong {date}, nang hiwalay at walang anumang pakikilahok ng Silence Laboratories.',
    dklsChanges:
      'Ang binago: nakatali ang isang signing session sa isang mensahe, at idinagdag ang adaptor pre-signing ng dalawang panig.',
    dklsNonCommercial:
      'Maaari lamang gamitin ang bahaging ito para sa mga layuning hindi pangkomersyo. Hindi saklaw ito ng sariling MIT na lisensya ng Frank.',
    dklsSource:
      'Nasa Frank repository, sa folder na {path}, ang source code ng binagong library.',
    licenseHeading: 'Lisensya ng DKLs23 library',
    licenseIntro:
      'Ang buong teksto ng lisensya, kasama ang mga kondisyon at disclaimer nito, ayon sa inilathala ng Silence Laboratories (Ingles lamang):',
  },
  swap: {
    interfaceFee: 'Bayarin ng Frank ({rate})',
    venueNote:
      'Testnet deployment na pinapatakbo ni {maintainer}, hindi ng Uniswap Labs',
    pay: 'Babayaran mo',
    payToken: 'Token na gagamitin mo sa pagbabayad',
    receive: 'Matatanggap mo',
    receiveToken: 'Token na matatanggap mo',
    switchTokens: 'Pagpalitin ang dalawang token',
    available: 'Magagamit',
    balance: 'Balanse',
    max: 'MAX',
    otherAccounts: '{amount} pa sa ibang mga account ng wallet na ito',
    testToken: 'test na token',
    reviewMove:
      'Ililipat muna ang {amount} {unit} mula sa iba mong account papunta sa pangunahing account mo, na magsasagawa ng swap.',
    reviewStale:
      'Hindi ma-refresh ang presyo. Sinusubukang muli; maaari kang magkumpirma kapag napapanahon na ito.',
    progressRecovering:
      'Tinatapos ang naunang transaksyon mula sa wallet na ito…',
    rate: 'Rate ng palitan',
    priceImpact: 'Epekto sa presyo',
    poolFee: 'Bayarin ng pool',
    minimumReceived: 'Minimum na matatanggap',
    networkFee: 'Bayarin sa network',
    networkFeeKnown: '{fee} {unit}',
    networkFeePartial:
      '{fee} {unit} para sa mga pag-apruba; malalaman ang sariling bayarin ng swap kapag nakumpirma ang mga iyon',
    reviewPaySame:
      'Babayaran mo ang {amount} {asset} + {fee} {unit} na bayarin sa network = {total} {unit}.',
    reviewPayOther:
      'Babayaran mo ang {amount} {asset} + {fee} {unit} na bayarin sa network.',
    reviewPayPartial:
      'Babayaran mo ang {amount} {asset} + {fee} {unit} na bayarin sa network para sa mga pag-apruba, kasama ang sariling bayarin sa network ng swap, na ipapakita kapag nakumpirma ang mga iyon.',
    reviewPayNoFee:
      'Babayaran mo ang {amount} {asset}, kasama ang bayarin sa network na hindi pa matantiya.',
    reviewReceive:
      'Makakatanggap ka ng humigit-kumulang {receive} {asset}. Kung mas mababa sa {minimum} {asset} ang makukuha mo, kakanselahin ang swap at mananatili sa iyo ang ibabayad mo sana.',
    resultPaidSame:
      'Binayaran mo ang {amount} {asset} + {fee} {unit} na bayarin sa network = {total} {unit}.',
    resultPaidOther:
      'Binayaran mo ang {amount} {asset} + {fee} {unit} na bayarin sa network.',
    resultPaidFeeOnly:
      'Nagbayad ka ng {fee} {unit} sa mga bayarin sa network at wala nang iba.',
    warnFeeLarger:
      'Mas malaki ang bayarin sa network kaysa sa halagang ipinagpapalit mo.',
    warnFeeShare:
      'Humigit-kumulang {percent}% ng halagang ipinagpapalit mo ang bayarin sa network.',
    networkFeeLater: 'tatantiyahin kapag naaprubahan',
    approval: 'Pag-apruba',
    approvalNeeded:
      '{count} transaksyon ng pag-apruba muna, para sa eksaktong halagang ito ng {asset}',
    slippage: 'Pinapayagang slippage',
    slippageCustom: 'Sariling slippage, sa porsyento',
    enterAmount: 'Maglagay ng halaga',
    review: 'Suriin ang swap',
    reviewTitle: 'Kumpirmahin ang swap na ito',
    reviewNote:
      'Sinusuri muli ang presyo kapag kinumpirma mo. Mag-e-expire ang swap {seconds} segundo matapos pirmahan.',
    back: 'Bumalik',
    confirm: 'Kumpirmahin ang swap',
    newSwap: 'Bagong swap',
    progressConsolidating:
      'Inililipat ang pondo sa account na magsasagawa ng swap…',
    progressApproving: 'Inaaprubahan ang eksaktong halaga ({step} sa {of})…',
    progressSigning: 'Inihahanda at isinusumite ang swap…',
    progressSubmitted: 'Naisumite. Hinihintay ang pagkumpirma ng network…',
    progressKeepOpen:
      'Maaari kang umalis sa pahinang ito: naitala ang swap at makikita sa Mga kamakailang swap.',
    resultConfirmed: 'Kumpleto ang swap',
    resultConfirmedDetail: 'Natanggap sa wallet mo, ayon sa naitala sa chain.',
    resultConfirmedUnknown:
      'Nakumpirma ang swap. Hindi mabasa mula sa resibo ang halagang natanggap; napapanahon ang balanse mo sa ibaba.',
    resultReverted: 'Hindi nakumpleto ang swap',
    resultRevertedSlippage:
      'Lumampas ang pagbabago ng presyo sa pinapayagan mong slippage, kaya kinansela ang swap. Napanatili mo ang pondo mo at bayarin sa network lamang ang binayaran.',
    resultRevertedDeadline:
      'Dumating sa network ang swap matapos itong mag-expire, kaya kinansela ito. Napanatili mo ang pondo mo at bayarin sa network lamang ang binayaran.',
    resultRevertedOther:
      'Tinanggihan ng network ang swap. Napanatili mo ang pondo mo at bayarin sa network lamang ang binayaran.',
    resultPending: 'Naisumite, hindi pa nakumpirma',
    resultPendingDetail:
      'Hindi pa nakumpirma ng network ang swap na ito. Maaari pa rin itong makumpleto; nag-a-update ang katayuan nito sa Mga kamakailang swap. Huwag itong ipadala muli.',
    unavailableNetwork:
      'Walang available na swap para sa wallet na ito sa network na ito.',
    unavailableSolana:
      'Hindi pa available ang mga swap para sa Solana wallet na ito.',
    unavailableWallet:
      'Hindi pa makapag-swap ang wallet na ito. Buksan ito at subukang muli.',
    unavailableError: 'Hindi mai-load ang swap. Suriin ang koneksyon mo.',
    errorSameAsset: 'Pumili ng dalawang magkaibang token.',
    errorInsufficientBalance: 'Hindi sapat ang {asset}',
    errorInsufficientForFee:
      'Hindi sapat ang {asset} para sa halagang ito kasama ang bayarin sa network',
    errorInsufficientNative:
      'Hindi sapat ang coin ng network upang bayaran ang swap na ito at bayarin nito.',
    errorNoRoute: 'Hindi maaaring ipagpalit dito ang dalawang token na ito.',
    errorNoLiquidity:
      'Hindi kayang tugunan ng pool ang halagang ito. Subukan ang mas maliit na halaga.',
    errorPriceMoved:
      'Lumampas ang pagbabago ng presyo sa pinapayagan mong slippage. Suriin ang bagong halaga.',
    errorExpired: 'Nag-expire ang swap bago naipadala. Suriin itong muli.',
    errorAllowance:
      'Wala o nag-expire na ang pag-apruba para sa halagang ito. Subukang muli.',
    errorAccountBusy:
      'Hindi pa nakumpirma ang naunang transaksyon mula sa wallet na ito. Subukang muli maya-maya.',
    errorApprovalFailed:
      'Hindi nakumpirma ang pag-apruba, kaya walang naipagpalit. Subukang muli.',
    errorAccountChanged: 'Nagbago ang account. Suriin muli ang swap.',
    errorQuote: 'Hindi makakuha ng presyo mula sa network. Subukang muli.',
    failureDiagnostic: 'Mga detalye ng pagkabigo: {stage} · {code}',
    errorExecution:
      'Hindi makumpirma ang katayuan ng swap. Tingnan ang Mga kamakailang swap bago subukang muli; maaari pa ring makumpleto ang naisumiteng swap.',
    warnHighImpact:
      'Malaki ang halagang ito para sa pool: kapansin-pansing mas mababa kaysa sa market rate ang matatanggap mo.',
    status: {
      confirmed: 'Nakumpirma',
      pending: 'Nakabinbin',
      failed: 'Hindi nakumpleto',
    },
  },
  solanaSwap: {
    route: 'Ruta',
    enterAmount: 'Maglagay ng halagang ipagpapalit',
    loading: 'Nilo-load ang mga Solana token mo…',
    unsupportedTitle: 'Hindi available ang mga swap sa network na ito',
    unsupportedBody:
      'Walang naka-on na palitan para sa Solana network na ito, kaya walang magagawang quote o swap dito.',
    loadError: 'Hindi mai-load ang mga Solana token mo.',
    pendingUnreadable:
      "Hindi mabasa sa device na ito ang naka-save na rekord ng kasalukuyang swap, kaya hindi alam kung may nakabinbin pang swap. Walang masisimulang bagong swap dito hangga't hindi ito nalulutas.",
    retry: 'Subukang muli',
    venueTestnet:
      'Nakikipagpalitan sa {venue}, {network}: mga test na token na walang tunay na halaga.',
    venueMainnet:
      'Nakikipagpalitan sa {venue}, {network}. Tunay na pondo ang ginagamit ng swap na ito.',
    payToken: 'Token na ibabayad mo',
    receiveToken: 'Token na matatanggap mo',
    flip: 'Pagpalitin ang dalawang token',
    slippage: 'Pinapayagang slippage',
    invalidAmount: 'Maglagay ng halagang may hanggang {decimals} decimal place',
    rate: 'Rate ng palitan',
    priceImpact: 'Epekto sa presyo',
    minimumReceived: 'Sa pinakamababa',
    tradeFee: 'Bayarin ng pool (kasama sa rate)',
    networkFee: 'Bayarin sa network',
    priorityFee: 'Bayarin para sa priyoridad',
    priorityFeeHint:
      'Itinatakda ng transaksyon upang maisama nang mas maaga; sisingilin nang buo kung maisasagawa sa chain ang swap',
    accountRent: 'Deposito upang buksan ang {token} account mo',
    accountRentHint:
      'Isang beses binabayaran. Nananatili ito sa sarili mong account at babalik kung isasara mo ito.',
    temporaryRent: 'Hinahawakan habang isinasagawa ang swap',
    temporaryRentHint:
      'Kailangan sa wallet mo habang isinasagawa ang swap; ibinabalik ito ng parehong transaksyon.',
    platformFee: 'Bayarin ng Frank ({percent}%)',
    platformFeeFromInput: 'Bahagi ng ibabayad mo.',
    platformFeeFromOutput: 'Nabawas na sa matatanggap mo.',
    totalLeaving: 'Kabuuang lalabas sa wallet mo',
    noPlatformFee: 'Walang idinaragdag na bayarin ang Frank sa swap na ito.',
    reviewSwap: 'Suriin ang swap',
    reviewTitle: 'Suriin ang swap na ito',
    reviewWhereTestnet:
      'Sa {venue}, sa {network}. Mga test na token ito na walang tunay na halaga.',
    reviewWhereMainnet:
      'Sa {venue}, sa {network}. Gumagamit ito ng tunay na pondo.',
    netLine:
      'Sa kabuuan: {give} ang lalabas sa wallet mo at humigit-kumulang {get} ang darating (hindi kailanman mas mababa sa {minimum}, kung hindi ay hindi matutuloy ang swap).',
    costWarning:
      'Ang mga bayarin at deposito ({costs}) ay {percent}% ng {amount} na ipinagpapalit.',
    back: 'Bumalik',
    confirmSwap: 'Kumpirmahin ang swap',
    refreshQuote: 'Kunin ang kasalukuyang quote',
    paid: 'Babayaran mo',
    expected: 'Matatanggap mo ang humigit-kumulang',
    actuallyPaid: 'Binayaran mo',
    networkFeeCharged: 'Nasingil na bayarin sa network',
    priorityFeeCharged: 'Nasingil na bayarin para sa priyoridad',
    totalLeft: 'Kabuuang lumabas sa wallet mo',
    received: 'Natanggap mo',
    checkAgain: 'Suriin muli',
    newSwap: 'Bagong swap',
    stage: {
      signing: 'Pinipirmahan…',
      submitted: 'Naipadala. Hinihintay ang pagkumpirma ng network…',
      confirmed: 'Kumpleto ang swap',
      failed: 'Nabigo ang swap',
      expired: 'Hindi naproseso ang swap',
      unknown: 'Sinusuri pa ang swap na ito',
    },
    stageNote: {
      signing: 'Pinipirmahan ng wallet mo ang swap. Wala pang ipinadala.',
      submitted:
        'Karaniwang ilang segundo ito. Maaari kang umalis sa pahinang ito; naitala ang swap at patuloy na sinusubaybayan.',
      confirmed:
        'Galing ang mga halagang ito sa nakumpirmang transaksyon, hindi sa quote.',
      failed:
        'Tinanggihan ng network ang swap, kaya walang naipagpalit. Bayarin sa network lamang ang binayaran.',
      expired:
        'Hindi isinama ng network ang swap bago ito mag-expire. Walang naipagpalit at walang nabayarang bayarin. Maaari mong subukang muli.',
      unknown:
        'Hindi makontak ang network, kaya hindi pa alam kung natuloy ang swap na ito. Hindi ito ipinadala muli bilang bagong swap.',
    },
    error: {
      invalidRequest:
        'Hindi mabigyan ng quote ang swap na ito. Maaaring masyadong maliit ang halaga, o magkapareho ang mga token.',
      noRoute: 'Walang merkado para sa pares na ito rito.',
      insufficientBalance: 'Hindi sapat ang token na ibabayad mo.',
      insufficientSol:
        'Hindi sapat ang SOL para sa swap na ito, bayarin sa network nito at mga deposito nito.',
      slippage:
        'Lumampas ang pagbabago ng presyo sa pinapayagan mong slippage. Kumuha ng bagong quote o taasan ang pinapayagan.',
      simulationFailed:
        'Tatanggihan ng network ang swap na ito, kaya hindi ito ipinadala.',
      venueUnavailable:
        'Hindi sumagot ang palitan. Subukang muli sa loob ng ilang segundo.',
      unsafeTransaction:
        'May ibang gagawin ang transaksyon para sa swap na ito bukod sa swap na binigyan ng quote, kaya hindi ito pinirmahan.',
      unexpected: 'May nangyaring mali at hindi ipinadala ang swap.',
    },
  },
  calendarInvite: {
    allDay: 'Buong araw',
    organizer: 'Tagapag-organisa',
    location: 'Lokasyon',
    statusConfirmed: 'Nakumpirma',
    statusTentative: 'Hindi pa tiyak',
    statusCancelled: 'Kinansela',
    rsvpTally:
      '{accepted} Tinanggap · {tentative} Hindi pa tiyak · {declined} Tinanggihan',
    accept: 'Tanggapin',
    tentative: 'Hindi pa tiyak',
    decline: 'Tanggihan',
    addToOsCalendar: 'Idagdag sa Apple / OS Calendar (.ics)',
    addToGoogleCalendar: 'Google Calendar',
    attachCalendarOrContact: 'Mag-attach ng Calendar (.ics) o Contact (.vcf)',
    invalidFile: 'Hindi mabasa ang {name}: {reason}',
  },
  contactCard: {
    title: 'Card ng Contact',
    frankAddress: 'Frank Address',
    email: 'Email',
    phone: 'Telepono',
    website: 'Website',
    addToContacts: 'Idagdag sa Mga Contact sa Frank',
    addedToContacts: 'Naidagdag sa Mga Contact sa Frank',
    saveVcf: 'I-save ang vCard (.vcf)',
  },
  onboard: {
    toolbarTitle: 'Pagsisimula sa Frank',
    headerBadge: 'Pagsisimulang End-to-End Encrypted at Sariling Pamamahala',
    heading: 'Ipagpatuloy ang pag-uusap mo sa Frank',
    keysGeneratedPrefix: 'Ginagawa ang mga private key mo',
    keysGeneratedHighlight: '100% lokal sa browser mo',
    keysGeneratedSuffix: 'at hindi kailanman ibinabahagi sa email gateway.',
    threadImportPrefix: 'Ang usapan mo sa email kay',
    threadImportSuffix: 'ay awtomatikong ii-import.',
    subjectLabel: 'Paksa:',
    bridgedEmailLabel: 'Naka-bridge na Email:',
    signedInAs: 'Naka-sign in bilang',
    localFrankAccount: 'Lokal na Frank Account',
    importThreadAndOpenChat: 'I-import ang Usapan at Buksan ang Chat sa Kausap',
    displayNameLabel: 'Pangalang Ipapakita',
    displayNameHint:
      'Ipinapakita sa mga contact kapag nagmensahe ka sa kanila sa Frank',
    createAccountAndOpenChat:
      'Gumawa ng Account na Sariling Pinamamahalaan at Buksan ang Chat',
    continueWithPasskey: 'Magpatuloy gamit ang Passkey (Mera)',
  },
  close: 'Isara',
  signedSwap: {
    actions: {
      offer: 'Alok',
      accept: 'Pagtanggap',
      reject: 'Pagtanggi',
    },
    title: 'Swap',
    negotiationOnly:
      'Pinirmahang negosasyon lamang. Ang pagtanggap ay hindi naglilipat o nagbibigay ng pahintulot na gamitin ang pondong mismong ipagpapalit.',
    offerAmount: 'Mag-alok ng {unit} sa {network}',
    requestAmount: 'Humiling ng {unit} sa {network}',
    expiry: 'Pag-expire ({timezone})',
    review: 'Suriin',
    propose: 'Pirmahan at imungkahi',
    newOffer: 'Bagong alok',
    accept: 'Tanggapin',
    reject: 'Tanggihan',
    confirmResponse: 'Pirmahan ang {decision}',
    stamp: 'Stamp ng mensahe',
    baseUnits: 'mga batayang yunit',
    history: 'Kasaysayan ng napatunayang negosasyon',
    pending: 'Mga naka-save na awtorisasyon',
    resume: 'Ipagpatuloy ang orihinal na awtorisasyon',
    selectExpiry: 'Pumili ng petsa at oras ng pag-expire.',
    delivery: 'Paghahatid ng mensahe',
    error: 'Hindi matapos ang negosasyon',
    legacy: 'Hindi suportadong kasaysayan ng swap na walang pirma',
    phases: {
      claimed: 'Hindi tapos ang pagpirma',
      signed: 'Na-save ang pirma',
    },
    deliveryStates: {
      'confirmed': 'Naihatid',
      'pending': 'Nakabinbin ang paghahatid',
      'payment-pending': 'Nakabinbin ang bayad sa stamp',
      'error': 'Hindi tapos ang paghahatid',
    },
    errors: {
      capacity:
        'Naabot ang kapasidad ng imbakan. Nananatiling nakatago ang mga naka-save na awtorisasyon.',
      expired:
        'Pumili ng pag-expire sa hinaharap para sa bagong awtorisasyon. Pinananatili ng mga pinirmahang mensahe ang orihinal nilang pag-expire.',
      conflict:
        'May ibang awtorisasyon nang nakatalaga sa signing slot na ito.',
      invalidAmount:
        'Maglagay ng positibong eksaktong decimal na halaga na pasok sa native precision at mga limitasyon ng protocol.',
      invalidIntent:
        'Hindi balido ang naka-save na awtorisasyon. Pinanatili ito para masuri.',
      sessionChanged:
        'Nagbago ang account, network o napatunayang pag-uusap. Suriin muli.',
      storage: 'Hindi available ang imbakan. Hindi itinapon ang awtorisasyon.',
      deliveryPending:
        'Na-save ang pirma at hindi pa tapos ang paghahatid ng orihinal nitong mensahe. Ipagpatuloy ito.',
      failed:
        'Hindi matapos ang negosasyon. Kung may na-save na awtorisasyon, nananatili itong nakatago.',
    },
    states: {
      'restoring': 'Ibinabalik ang ebidensya ng negosasyon',
      'scanning': 'Sinusuri ang mga napatunayang mensahe',
      'ready': 'Handa',
      'unsupported': 'Hindi available ang negosasyon ng swap sa network na ito',
      'incomplete': 'Hindi kumpleto ang napatunayang ebidensya',
      'capacity': 'Naabot ang kapasidad ng imbakan ng negosasyon',
      'storage-error': 'Nabigo ang imbakan ng negosasyon',
      'awaitingAdmission':
        'Naghihintay ang pinirmahang event na mapatunayang karapat-dapat tanggapin',
      'conflict': 'Magkasalungat na ebidensya ng negosasyon',
      'expired': 'Nag-expire ang negosasyon',
      'offered': 'Napatunayang alok',
      'accept':
        'Napatunayang pagtanggap; hindi pinahihintulutan ang paglilipat ng pondong mismong ipagpapalit',
      'reject': 'Napatunayang pagtanggi',
    },
  },
}
