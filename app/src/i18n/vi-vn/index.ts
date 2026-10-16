export default {
  negotiationRecovery: {
    'restoring': 'Đang khôi phục lịch sử hoán đổi',
    'scanning': 'Đang kiểm tra lịch sử hoán đổi',
    'ready': 'Đã khôi phục lịch sử hoán đổi',
    'unsupported': 'Không thể khôi phục hoán đổi trên mạng này',
    'incomplete': 'Chưa kiểm tra xong lịch sử hoán đổi',
    'capacity': 'Bộ nhớ lịch sử hoán đổi đã đầy',
    'storage-error': 'Không thể khôi phục lịch sử hoán đổi',
  },
  qrScanner: {
    paymentHint:
      'Để thanh toán, hãy quét mã QR Nhận của ví. Mã QR hồ sơ xác định một liên hệ nhắn tin, không phải địa chỉ nạp tiền vào ví.',
    open: 'Quét mã QR',
    title: 'Quét địa chỉ',
    network: 'Mạng: {network}',
    addressOnly:
      'Quét địa chỉ thuần của mạng này. Kiểm tra trước khi xác nhận. Không hỗ trợ liên kết thanh toán.',
    starting: 'Đang mở máy ảnh…',
    scanning: 'Hướng máy ảnh vào mã QR.',
    invalid: 'Mã QR này không phải địa chỉ được hỗ trợ trên mạng này.',
    denied:
      'Quyền truy cập máy ảnh bị từ chối. Hãy cho phép truy cập hoặc nhập địa chỉ thủ công.',
    unavailable:
      'Không dùng được máy ảnh. Hãy dùng HTTPS và trình duyệt được hỗ trợ, hoặc nhập địa chỉ thủ công.',
    retry: 'Thử lại',
    manual: 'Nhập thủ công',
  },
  notificationPermission: {
    title: 'Thông báo',
    default: 'Chưa bật thông báo trình duyệt.',
    granted: 'Đã bật thông báo trình duyệt.',
    denied:
      'Thông báo trình duyệt bị chặn. Hãy cho phép thông báo trong cài đặt trang web của trình duyệt rồi quay lại Frank.',
    unsupported: 'Trình duyệt này không hỗ trợ thông báo trên màn hình.',
    enable: 'Bật thông báo',
    notNow: 'Để sau',
    offer: 'Nhận thông báo khi có tin nhắn',
    offerHint:
      'Bật thông báo trình duyệt ngay hoặc sau này trong Cài đặt → Thông báo.',
    contactHint:
      'Tùy chọn thông báo của từng liên hệ độc lập với quyền trình duyệt này.',
    failed:
      'Không thể bật thông báo. Hãy kiểm tra cài đặt trang web của trình duyệt.',
  },
  startupFailure: {
    title: 'Không thể tải dữ liệu đã lưu',
    message: 'Đã dừng khởi động. Dữ liệu đã lưu của bạn chưa bị đặt lại.',
    loading: 'Đang tải dữ liệu đã lưu',
  },
  tempoPayment: {
    interrupted:
      'Một khoản thanh toán Tempo cần được kiểm tra. Quay lại tài khoản đã bắt đầu khoản thanh toán và xem Hoạt động thanh toán. Nếu được yêu cầu, tiếp tục chính khoản thanh toán đó tại đó; đừng tạo khoản thanh toán khác cho nó.',
    dismiss: 'Đóng',
  },
  accountRecovery: {
    mera_title: 'Mera',
    mera_choose:
      'Dùng khóa truy cập hiện có hoặc tạo tài khoản mới với khóa truy cập mới.',
    mera_existing: 'Dùng khóa truy cập hiện có',
    mera_new: 'Tạo khóa truy cập mới',
    mera_create: 'Tạo với Mera',
    mera_login: 'Tiếp tục với Mera (khóa truy cập)',
    mera_verification_unreachable:
      'Không thể xác minh tài khoản hiện có. Tài khoản dùng khóa truy cập đã sẵn sàng để xác nhận; hãy kiểm tra kết nối trước khi tiếp tục.',
    mera_description:
      'Khóa truy cập mới tạo ra tài khoản Frank mới. Đăng nhập bằng khóa truy cập hiện có để quay lại cùng tài khoản trên trang web này. Bạn cũng có thể lưu các mảnh khôi phục từ phần sao lưu tài khoản.',
    mera_unsupported:
      'Khóa truy cập cần trang web bảo mật và trình duyệt được hỗ trợ. Thay vào đó, hãy dùng chức năng tạo tài khoản hoặc các mảnh khôi phục.',
    mera_cancelled:
      'Yêu cầu khóa truy cập đã bị hủy hoặc hết thời gian chờ. Chưa có tài khoản nào được kích hoạt. Hãy thử lại khi sẵn sàng.',
    mera_prf:
      'Khóa truy cập hoặc trình duyệt này không cung cấp bí mật PRF cần thiết. Chưa có tài khoản nào được kích hoạt. Hãy dùng nhà cung cấp khóa truy cập và trình duyệt được hỗ trợ, hoặc dùng các mảnh khôi phục.',
    mera_failed:
      'Không thể hoàn tất yêu cầu khóa truy cập. Chưa có tài khoản nào được kích hoạt. Thử lại với cùng khóa truy cập. Có thể khóa đã được tạo trước lỗi này; hãy thử đăng nhập bằng khóa truy cập hiện có.',
    wallet_chain_mismatch:
      'Ví đã lưu này không khớp với mạng hoặc cấu hình tài khoản ứng dụng đang dùng. Khôi phục cấu hình mạng trước đó rồi thử mở lại tài khoản hiện có. Dữ liệu đã lưu chưa bị thay đổi.',
    profile_restore_unreachable:
      'Đã khôi phục tài khoản nhưng không thể tải hồ sơ. Kiểm tra kết nối máy chủ chuyển tiếp rồi thử lại.',
    profile_restore_retry: 'Thử tìm hồ sơ lại',
    pending_outdated_cancel_and_redo:
      'Lần thử này được lưu bởi phiên bản Frank trước đó và không thể kích hoạt. Hủy rồi tạo hoặc khôi phục tài khoản lại. Các mảnh bạn đã ghi vẫn khôi phục được tài khoản.',
    pending_retry:
      'Chưa thể hoàn tất việc dọn dẹp tài khoản đang chờ. Tài khoản đang hoạt động không thay đổi. Thử lại hoặc hủy lần thử này trước khi bắt đầu lần khác.',
    balance_loading: 'Đang tải số dư…',
    balance_unavailable: 'Không thể tải số dư. Đang thử lại.',
    balance_stale:
      'Số dư được biết gần nhất — làm mới thất bại. Giá trị này có thể đã cũ.',
    profile_unavailable:
      'Chưa thể công bố hồ sơ công khai và nhắn tin trực tiếp cho tài khoản này. Sẽ không công bố danh tính lên danh bạ cũ. Tên tài khoản cục bộ của bạn không thay đổi.',
    open_navigation: 'Mở điều hướng',
    frank_account: 'Tài khoản Frank',
    saved_account_data_could_not_be_opened:
      'Không thể mở dữ liệu tài khoản đã lưu. Dữ liệu chưa bị thay thế. Bản xem trước này yêu cầu bộ nhớ trình duyệt được mã hóa; không hỗ trợ ứng dụng gốc.',
    retry_opening_account: 'Thử lại',
    reset_account_storage: 'Đặt lại bộ nhớ',
    reset_account_storage_confirm:
      'Đặt lại bộ nhớ hỏng sẽ xóa dữ liệu tài khoản cục bộ không mở được. Sau đó bạn có thể khôi phục tài khoản từ các mảnh sao lưu. Tiếp tục?',
    a_saved_account_attempt_is_pending_it:
      'Có một lần thử tài khoản đã lưu đang chờ. Tài khoản chưa hoạt động cho đến khi bạn chọn Kích hoạt tài khoản.',
    account_found: 'Xác nhận danh tính',
    activate_account: 'Kích hoạt',
    pending_identity_address:
      'Kích hoạt sẽ mở tài khoản có địa chỉ danh tính này. Hồ sơ đã công bố sẽ được tải riêng:',
    pending_username: 'Tên người dùng',
    pending_profile_loading: 'Đang kiểm tra hồ sơ đã công bố…',
    pending_profile_unreachable:
      'Không thể kiểm tra hồ sơ đã công bố. Kiểm tra kết nối máy chủ chuyển tiếp rồi thử lại. Bạn vẫn có thể xác nhận địa chỉ danh tính.',
    pending_profile_unverified:
      'Không thể xác minh hồ sơ trả về cho danh tính này. Kiểm tra địa chỉ danh tính trước khi kích hoạt.',
    pending_identity_stop_if_unexpected:
      'Nếu bạn đang khôi phục tài khoản và đây không phải địa chỉ mong đợi, hãy dừng lại: đừng kích hoạt. Hãy hủy lần thử.',
    the_attempt_is_incomplete_or_awaiting_cleanup:
      'Lần thử chưa hoàn tất hoặc đang chờ dọn dẹp. Hãy chủ động hủy trước khi bắt đầu tài khoản khác.',
    cancel_pending_attempt: 'Hủy',
    create_a_frank_account_backup_or_restore:
      'Tạo tài khoản Frank cùng bản sao lưu hoặc khôi phục từ các mảnh khôi phục đã lưu. Không cần có tiền để kích hoạt cục bộ.',
    an_existing_legacy_account_is_quarantined_its:
      'Một tài khoản cũ hiện có đã được cách ly. Dữ liệu đã lưu vẫn nguyên vẹn và không được mở như tài khoản thông thường.',
    changing_accounts_replaces_the_active_local_account:
      'Đổi tài khoản sẽ thay thế tài khoản cục bộ đang hoạt động sau khi xác nhận sao lưu. Hãy giữ bản sao lưu hiện có.',
    i_understand_this_changes_the_active_local:
      'Tôi hiểu rằng việc này thay đổi danh tính cục bộ đang hoạt động và không chuyển tiền hoặc lịch sử.',
    new_account: 'Tài khoản mới',
    restore_account: 'Khôi phục tài khoản',
    legacy_recovery_migration: 'Khôi phục tài khoản cũ',
    return_to_wallet: 'Quay lại',
    this_identifies_your_old_account_locally_you:
      'Nhập cụm từ BIP39 đã lưu cho tài khoản Frank. Kiểm tra địa chỉ danh tính trước khi kích hoạt. Hồ sơ hiện có sẽ được tải sau khi khôi phục.',
    legacy_bip39_recovery_phrase: 'Cụm từ khôi phục BIP39 cũ',
    identify_legacy_account_locally: 'Khôi phục tài khoản BIP39',
    old_account: 'Tài khoản cũ:',
    the_new_identity_is_different_no_funds:
      '. Danh tính mới khác với danh tính cũ; không di chuyển tiền, lịch sử hay khóa từ xa.',
    choose_how_many_shares_you_must_retain:
      'Chọn số mảnh bạn phải giữ lại. Mất quá nhiều mảnh sẽ mất quyền truy cập vĩnh viễn. Giữ các mảnh ở những nơi an toàn riêng biệt; bất kỳ ai có đủ số mảnh theo ngưỡng đều có thể khôi phục tài khoản.',
    generate_frank_account_backups: 'Tạo bản sao lưu',
    frank_account_backup: 'Sao lưu tài khoản Frank',
    save_each_share_before_moving_on_exactly:
      '. Lưu từng mảnh trước khi tiếp tục. Cần đúng',
    consistent_shares_are_required_to_confirm: 'mảnh nhất quán để xác nhận.',
    frank_account_backup_share: 'Mảnh sao lưu tài khoản Frank',
    copy_this_share: 'Sao chép mảnh này',
    save_two_independent_copies_of_this_public:
      'Lưu hai bản độc lập của bản mô tả tài khoản công khai này cùng hồ sơ khôi phục. Nó dùng để đối chiếu tài khoản khôi phục, nhưng tự nó không chứng minh quyền sở hữu. Dùng bản đã lưu độc lập khi khôi phục.',
    public_frankdesc_descriptor: 'Bản mô tả frankdesc công khai',
    copy_public_descriptor: 'Sao chép bản mô tả công khai',
    i_saved_two_independent_copies_of_the:
      'Tôi đã lưu hai bản độc lập của bản mô tả công khai.',
    confirm_my_saved_backups: 'Xác nhận bản sao lưu',
    enter_the_public_frankdesc_descriptor_from_an:
      'Trước tiên nhập bản mô tả frankdesc công khai từ một bản đã lưu độc lập. Đây là siêu dữ liệu đối chiếu tài khoản, không phải bằng chứng tự xác thực. Tuyệt đối không dùng bản mô tả suy ra từ các mảnh đã gửi.',
    independently_saved_frankdesc_descriptor:
      'Bản mô tả frankdesc đã lưu độc lập',
    pin_expected_account: 'Cố định tài khoản mong đợi',
    re_enter_exactly: 'Nhập lại đúng',
    saved_frank_account_backup_shares_we_reconstruct:
      'mảnh sao lưu tài khoản Frank đã lưu. Chúng tôi sẽ tái tạo và đối chiếu toàn bộ tài khoản trước khi chuẩn bị kích hoạt.',
    enter_at_least_the_threshold_number_of_shares:
      'Nhập ít nhất số mảnh theo ngưỡng in trên bản sao lưu, mỗi dòng một mảnh. Các mảnh bổ sung cùng bản sao lưu giúp ứng dụng phát hiện và chỉ ra mảnh sai.',
    share_report_title:
      'Ứng dụng tìm thấy những điều sau trong các mảnh bạn nhập:',
    share_report_supports: 'Mảnh {n} (chỉ mục {index}): đã dùng.',
    share_report_inconsistent:
      'Mảnh {n} (chỉ mục {index}): không thuộc bản sao lưu này. Mảnh bị sai hoặc hỏng.',
    share_report_different_set:
      'Mảnh {n} (bộ {identifier}): thuộc bộ sao lưu khác.',
    share_report_duplicate: 'Mảnh {n}: đã nhập nhiều lần.',
    share_report_invalid: 'Mảnh {n}: không đọc được. Kiểm tra lỗi gõ.',
    restore_choose_explained:
      'Các mảnh này chứa bản sao lưu đầy đủ của nhiều tài khoản. Frank sẽ không chọn thay bạn. Nếu bạn không mong đợi điều này, có thể ai đó đã đưa cho bạn các mảnh của tài khoản họ kiểm soát. Chỉ khôi phục địa chỉ bạn nhận ra.',
    restore_choose_identity: 'Tài khoản có địa chỉ danh tính này:',
    restore_choose_shares: 'Tạo từ các mảnh {shares}.',
    restore_choose_pick: 'Khôi phục tài khoản này',
    expected_account: 'Tài khoản mong đợi:',
    insufficient_share_set:
      'Bản sao lưu {identifier}: có {available} mảnh khác nhau; cần {required} mảnh.',
    saved_codex32_shares_one_per_line:
      'Các mảnh khôi phục đã lưu, mỗi dòng một mảnh',
    display_name: 'Tên hiển thị',
    display_name_required:
      'Bắt buộc. Đây là tên những người bạn nhắn tin sẽ thấy; bạn có thể đổi sau trong hồ sơ.',
    verify_backups_and_stage_account:
      'Xác minh bản sao lưu và chuẩn bị tài khoản',
    cancel_and_start_again: 'Hủy',
    browser_preview_encrypted_local_storage_does_not:
      'Bản xem trước trên trình duyệt: bộ nhớ cục bộ mã hóa không bảo vệ khỏi mã độc từ nguồn gốc web này hoặc việc đánh cắp toàn bộ hồ sơ trình duyệt. Giữ bản sao lưu độc lập. Xóa dữ liệu cục bộ có thể làm mất quyền truy cập.',
    messaging_is_unavailable_for_typed_accounts_in:
      'Không dùng được nhắn tin cho tài khoản có kiểu trong bản xem trước này.',
    main_wallet: 'Ví chính',
    frank_account_recovery: 'Khôi phục tài khoản Frank',
    backup_shares_were_verified_before_activation_keep:
      'Các mảnh sao lưu đã được xác minh trước khi kích hoạt. Giữ bản đã lưu an toàn. Các khóa gốc miền lưu trên thiết bị không thể tái tạo bí mật gốc ban đầu hay các mảnh sao lưu.',
    public_recovery_descriptor: 'Bản mô tả khôi phục công khai',
    fingerprint: 'Dấu vân tay:',
    create_or_restore_account: 'Tạo hoặc khôi phục tài khoản',
    frank_account_backups_were_verified_before_activation:
      'Bản sao lưu tài khoản Frank đã được xác minh trước khi kích hoạt. Giữ các mảnh và bản mô tả công khai đã lưu; thiết bị này không thể tái tạo các mảnh sao lưu ban đầu.',
    browser_storage: 'Bộ nhớ trình duyệt',
    browser_persistence_reduces_automatic_eviction_it_is:
      'Lưu trữ bền vững trong trình duyệt giảm nguy cơ tự động xóa dữ liệu. Đây không phải bản sao lưu hay biện pháp bảo vệ khỏi mã độc hoặc việc đánh cắp hồ sơ trình duyệt.',
    request_persistent_storage: 'Yêu cầu lưu trữ bền vững',
    keep_independent_account_backup:
      'Giữ bản sao lưu tài khoản độc lập. Bảo vệ bộ nhớ trình duyệt không phải là sao lưu.',
    import_bip39_seed: 'Nhập hạt giống BIP39',
    not_backed_up_tooltip:
      'Bạn chưa sao lưu ví hoặc danh tính. Nhấn để sao lưu ngay.',
    backup_account_codex32: 'Sao lưu tài khoản',
    codex32_threshold_explainer:
      'Ghi lại từng mảnh. Bất kỳ {threshold} mảnh nào trong số {count} mảnh này đều khôi phục được bí mật tài khoản gốc và phép dẫn xuất của nó.',
    codex32_backup_sets_do_not_mix:
      'Đây là bộ mới. Không thể kết hợp các mảnh từ những bộ khác nhau, kể cả các mảnh hiển thị khi tạo tài khoản. Đổi cấu hình hoặc mở lại trang này sẽ tạo bộ khác, vì vậy hãy ghi xong bộ này trước.',
    cancel_scheme: 'Hủy',
    recovery_shares_privacy:
      'Bất kỳ ai nhìn thấy các mảnh này đều có thể chiếm tài khoản. Đảm bảo không ai khác nhìn thấy màn hình của bạn.',
    codex32_backup_unavailable_for_account:
      'Thiết bị này không có bí mật gốc cần thiết để tạo các mảnh sao lưu. Bản sao lưu hiện có vẫn hợp lệ.',
    historical_share_keep_both_lines:
      'Giữ dòng Hạt giống và Kiểm tra cùng nhau thành một mảnh giấy. Nhập cả hai dòng cùng nhau khi khôi phục.',
    backup_seed_line: 'Hạt giống',
    backup_check_line: 'Kiểm tra',
    configure_scheme: 'Cấu hình ngưỡng và số mảnh',
    custom_threshold_shares: 'Ngưỡng và số mảnh tùy chỉnh',
    threshold: 'Ngưỡng',
    total_shares: 'Tổng số mảnh',
    apply: 'Áp dụng',
    generating_codex32_backup_shares: 'Đang tạo các mảnh khôi phục…',
    share: 'Mảnh',
    copy_share: 'Sao chép',
    verify_shards_title: 'Xác minh các mảnh',
    verify_shards_explainer:
      'Kiểm tra các mảnh đã lưu bằng cách nhập ít nhất số mảnh theo ngưỡng để xác minh rằng chúng tái tạo được tài khoản.',
    verify_shards_button: 'Xác minh các mảnh',
    verify_shards_clear: 'Xóa',
    verify_shards_success:
      'Đã xác minh các mảnh thành công! Bản sao lưu hợp lệ.',
    advanced_details: 'Chi tiết nâng cao',
    advanced_options: 'Tùy chọn nâng cao',
    relay_server: 'Máy chủ chuyển tiếp',
    relay_server_url: 'URL máy chủ chuyển tiếp',
    relay_server_url_hint:
      'Máy chủ chuyển tiếp chính cho hộp thư mã hóa và hồ sơ của bạn',
    reset_to_default_relay: 'Đặt lại về máy chủ chuyển tiếp mặc định',
    invalid_relay_url: 'Vui lòng nhập URL HTTP hoặc HTTPS hợp lệ',
    relay_discovered:
      'Đã tìm thấy máy chủ chuyển tiếp chính hiện có: {url}. Đã cấu hình tự động.',
    frank_is_open_in_another_tab: 'Frank đang mở trong thẻ khác',
    multi_tab_notice:
      'Tài khoản vẫn được lưu trên thiết bị này. Frank đang hoạt động trong thẻ hoặc cửa sổ khác. Để bảo vệ ví, mỗi lúc chỉ một thẻ có thể dùng tài khoản. Chọn “Dùng Frank tại đây” để tiếp tục ở đây và tạm dừng thẻ kia.',
    use_frank_here: 'Dùng Frank tại đây',
    switch_to_open_tab: 'Tìm thẻ Frank đang mở',
    find_tab_waiting: 'Đang liên hệ thẻ Frank đang mở…',
    find_tab_focused:
      'Thẻ Frank đang mở đã phản hồi. Nếu thẻ chưa xuất hiện, hãy chọn nó trong trình duyệt.',
    find_tab_notified:
      'Một thông báo đã được gửi từ thẻ Frank đang mở. Nhấp để quay lại đó. Nếu không thấy thông báo, hãy chọn thẻ trong trình duyệt.',
    find_tab_manual:
      'Thẻ Frank đang mở đã phản hồi, nhưng trình duyệt không thể tự động chuyển sang thẻ đó.',
    find_tab_unavailable:
      'Thẻ Frank đang mở không phản hồi. Có thể trình duyệt đã tạm ngưng thẻ.',
    find_tab_idle: 'Tìm thẻ Frank đang mở hoặc chọn “Dùng Frank tại đây”.',
    find_tab_notification_title: 'Thẻ Frank đang mở của bạn',
    find_tab_notification_body:
      'Nhấp thông báo này để quay lại thẻ Frank đang dùng tài khoản của bạn.',
    manual_tab_switch_hint:
      'Chọn thẻ Frank trên thanh thẻ hoặc màn hình tổng quan của trình duyệt. Nếu không tìm thấy, chọn “Dùng Frank tại đây” để chuyển tài khoản sang thẻ này.',
    tab_yielded_notice: 'Frank đang hoạt động trong thẻ hoặc cửa sổ khác.',
  },
  agree: 'Đồng ý',
  chat: {
    groupRecipientNoticeSelf:
      'Tin nhắn bạn gửi tại đây là ghi chú cho chính mình. Không ai khác đã đăng ở đây nhận được chúng.',
    groupRecipientNotice:
      'Tin nhắn của bạn ở đây chỉ gửi tới {name}, không gửi tới mọi người trong cuộc trò chuyện này.',
    sendMessage: 'Gửi tin nhắn',
    stampPreparationChecking: 'Đang kiểm tra các tài khoản tem riêng tư…',
    stampPreparationFunding:
      'Đang chuẩn bị tài khoản tem riêng tư ({completed}/{total} giao dịch trên chuỗi; mỗi giao dịch dự phòng phí tối đa {feeReserve} {unit})…',
    stampPreparationReady:
      'Tài khoản tem riêng tư đã sẵn sàng; đang gửi tin nhắn…',
    stampPreparationWaiting: 'Đang chờ khoản thanh toán trước được xác nhận…',
    stampPreparationWaitingBlocks:
      'Đang chờ khoản thanh toán trước được xác nhận (còn {blocks} khối)…',
    sendContextChanged:
      'Tài khoản, chuỗi hoặc cuộc trò chuyện đã thay đổi. Hãy kiểm tra lại thao tác.',
    chainUnreachable:
      'Không thể kết nối mạng. Tin nhắn có thanh toán được xếp hàng và sẽ gửi khi mạng hoạt động trở lại.',
    donationMessage:
      'Cảm ơn bạn đã tham gia tầm nhìn của chúng tôi về tương lai giao tiếp trực tuyến. Hãy cân nhắc ủng hộ nỗ lực này bằng cách gửi BCH thật đến bitcoincash:qq7vt04md0pt6fk5szhcx4cgsfuzmppy5u4hxshr4a',
  },
  stampPreparation: {
    refreshStatus: 'Làm mới trạng thái',
    posting: 'Đang đăng…',
    voting: 'Đang bỏ phiếu…',
    sendingVote: 'Đang gửi phiếu…',
    postCreated: 'Đã tạo bài đăng trong {topic}.',
    replyParentLoading: 'Đang tải bài đăng bạn đang trả lời…',
    replyParentUnavailable:
      'Không thể tải bài đăng bạn đang trả lời. Bạn có thể thử lại.',
    retryReplyParent: 'Thử lại',
    postedRefreshFailed:
      'Bài đăng đã được công bố nhưng làm mới thất bại. Tải lại để xem. Đừng đăng lại.',
    postOutcomeUnknown:
      'Bài đăng có thể đã được công bố. Tải lại để kiểm tra. Đừng đăng lại.',
    votedRefreshFailed:
      'Phiếu của bạn đã được gửi nhưng làm mới thất bại. Tải lại để xem. Đừng bỏ phiếu lại.',
  },
  forum: {
    postsLabel: 'bài đăng',
    noPosts: 'Chưa có bài đăng.',
    outageTitle: 'Không dùng được diễn đàn',
    outageDescription:
      'Không thể kết nối máy chủ chuyển tiếp diễn đàn. Hãy kiểm tra kết nối hoặc thử lại.',
    outageBanner:
      'Hiện không thể kết nối máy chủ chuyển tiếp diễn đàn. Đang hiển thị bài đăng đã lưu.',
    degradedTitle: 'Kết nối suy giảm',
    degradedBanner: 'Không thể cập nhật một số chủ đề diễn đàn.',
    retry: 'Thử lại',
    loginSignUp: 'Đăng nhập / Đăng ký',
    thread: 'Luồng thảo luận',
    allTopics: 'Tất cả chủ đề',
    filteredBy: 'Đã lọc theo chủ đề',
    clearTopicFilter: 'Xóa bộ lọc',
    percentileFilter: 'Bộ lọc phân vị',
    allPosts: 'Tất cả bài đăng',
    editor: {
      toolbar: 'Công cụ định dạng',
      bold: 'Đậm',
      italic: 'Nghiêng',
      heading: 'Tiêu đề',
      quote: 'Trích dẫn',
      code: 'Mã',
      bullet: 'Danh sách dấu đầu dòng',
      link: 'Liên kết',
      attachImage: 'Đính kèm ảnh',
      imageProcessing: 'Đang xử lý ảnh…',
      imageTooLarge: 'Ảnh quá lớn để đăng (phải dưới 120 KB sau khi nén)',
      imageError: 'Không thể xử lý ảnh đính kèm',
      invalidImageType: 'Hãy chọn tệp ảnh hợp lệ (PNG, JPEG, WebP, GIF)',
      removeAttachment: 'Gỡ tệp đính kèm',
    },
  },
  chatLayout: {
    invalidSubject:
      'Dùng chủ đề dài tối đa 512 byte UTF-8, không có ký tự điều khiển.',
    participantCount: '{count} người tham gia',
    editSubject: 'Sửa chủ đề',
    subject: 'Chủ đề',
    saveSubject: 'Lưu',
    cancelSubject: 'Hủy',
    info: 'Thông tin',
    infoTitle: 'Thông tin',
    mute: 'Tắt thông báo',
    unmute: 'Bật lại thông báo',
    selectMessages: 'Xóa tin nhắn',
    selectMessagesTitle: 'Xóa tin nhắn',
  },
  chatInput: {
    giveLotusSecretly: 'Tặng Lotus bí mật',
    sendStealth: 'Gửi ẩn danh',
    offerSwap: 'Đề nghị hoán đổi nguyên tử',
    attachImage: 'Đính kèm ảnh',
    removeAttachment: 'Gỡ {name}',
    imageRefused: 'Không thể gửi {name}: {reason}.',
    messageTooLarge:
      'Tin nhắn này quá lớn để gửi. Hãy bỏ bớt ảnh hoặc rút ngắn văn bản.',
    blackjackChallenge: 'Thách đấu blackjack',
    placeHolder: 'Viết tin nhắn...',
    emojiPickerTitle: 'Chọn biểu tượng cảm xúc',
    stampPrice: 'Giá tem',
    stampPayment: 'Thanh toán tem',
    stampQuickSelection:
      'Chọn nhanh: miễn phí, một phần hoặc bội số của mức mặc định',
    stampMultiplierValue: '{multiplier}× mức mặc định ({amount})',
    defaultStamp: 'Mặc định: {amount}',
    stampBelowMinimum:
      'Số tiền này thấp hơn mức tối thiểu hiện tại là {amount} {unit}. Chọn số tiền khác hoặc tin nhắn miễn phí.',
    stampQuoteUnavailable: 'Không có mức tem mặc định',
    fixedStampFallback:
      'Mặc định tạm thời: {amount} {unit}, dựa trên số tiền cơ sở cố định và mức phí sàn hiện tại. Không có tỷ giá AVU.',
    stampQuoteUnavailableReason:
      'Không có mức tem mặc định: {reason}. Chọn số tiền cụ thể hoặc tin nhắn miễn phí.',
    stampQuoteReasons: {
      'messaging-pending': 'tài khoản vẫn đang kết nối',
      'missing-rate': 'thiếu tỷ giá chuyển đổi',
      'stale-rate': 'tỷ giá chuyển đổi đã cũ',
      'missing-fee': 'không có ước tính phí',
      'unsupported': 'không hỗ trợ nhắn tin',
    },
    resetToDefault: 'Đặt lại về mặc định',
    stampReset: 'Mặc định',
    stampFree: 'Miễn phí',
    stampChipFree: 'Không có tem: tin nhắn này miễn phí',
    stampChip: 'Tem: {amount}',
    stampChipMultiple: 'Tem: {amount}, {multiplier}× mức mặc định',
    stampWhat:
      'Tem là khoản thanh toán nhỏ gửi kèm tin nhắn tới người bạn đang viết cho. Khoản này trả cho sự chú ý của họ.',
    stampWhy:
      'Mỗi tin nhắn mang tem mặc định trừ khi bạn chọn số tiền khác cho cuộc trò chuyện này. Nhập 0 để gửi tin nhắn miễn phí.',
  },
  digitalGoods: {
    catalog: 'Danh mục',
    buy: 'Mua',
    confirmPrompt: 'Trả {price} cho {name} ({address}) để mua "{item}"?',
    confirmBuy: 'Xác nhận và trả {price}',
    cancel: 'Hủy',
    confirmGroupLabel: 'Xác nhận mua {item}',
    priceUnavailable: 'không có giá',
    hiddenOne: 'Còn {count} mặt hàng chưa hiển thị',
    hiddenMany: 'Còn {count} mặt hàng chưa hiển thị',
    requested: 'Đã yêu cầu: {itemId}',
    fulfilled: 'Đây là hàng bạn đã mua ({itemId}):',
  },
  chatImage: {
    onePhoto: '📷 Ảnh',
    manyPhotos: '📷 {count} ảnh',
    notShown: 'Không hiển thị ảnh ({reason})',
    reasonNotAnImage: 'không phải ảnh',
    reasonTooLarge: 'quá lớn',
    reasonNotInline: 'không phải ảnh nội tuyến',
    reasonUnreadableHeader: 'không đọc được phần đầu ảnh',
    reasonEmpty: 'ảnh trống',
    reasonDimensionsTooLarge: 'kích thước ảnh quá lớn',
  },
  raffle: {
    enter: 'Tham gia',
    confirmGroupLabel: 'Xác nhận tham gia bốc thăm',
    confirmPrompt: 'Trả {amount} để tham gia?',
    confirm: 'Xác nhận',
    cancel: 'Hủy',
    insufficient:
      'Số tiền vượt quá mức bạn có thể chi tiêu hiện tại ({balance}).',
    balanceUnknown: 'Chưa biết số dư của bạn.',
    leave: 'Rời đi',
    leaveAriaLabel: 'Rời vòng bốc thăm {raffleId}',
    leftAction: 'Đã rời bốc thăm',
    leftStatus:
      'Đã rời bốc thăm: {count}/{max} người tham gia. Tiền tham gia của bạn đã được hoàn lại.',
  },
  gameFairness: {
    diceRejected: 'Chưa có lần tung nào.',
    diceRejectionReasons: {
      'roll-not-offered': 'Lần tung này chưa được đề nghị.',
      'commitment-mismatch': 'Cam kết không khớp với lần tung được đề nghị.',
      'invalid-client-seed': 'Giá trị ngẫu nhiên của người chơi không hợp lệ.',
      'invalid-target': 'Mục tiêu của lần tung không hợp lệ.',
      'invalid-wager': 'Tiền cược không hợp lệ.',
      'below-minimum': 'Tiền cược thấp hơn mức tối thiểu.',
      'payout-limit': 'Tiền thưởng có thể nhận vượt quá giới hạn bàn.',
      'payment-not-confirmed': 'Khoản thanh toán cược chưa được xác nhận.',
    },
    dicePractice: 'Luyện tập',
    dicePracticeDescription:
      'Không cược, không có tiền thưởng. Luyện tập dùng cùng quy tắc tung mà không cược tiền.',
    dicePracticeRoll: 'Tung thử',
    diceRoll: 'Tung',
    moveNotSent:
      'Chưa gửi. Dùng Thử lại trên tin nhắn bên dưới, hoặc bỏ tin nhắn để chọn lại.',
    notVerified: 'CHƯA XÁC MINH.',
    diceVerified:
      'Đã xác minh: bí mật khớp với cam kết bạn đã đặt cược, và con số, kết quả cùng tiền thưởng được suy ra từ bí mật đó và giá trị ngẫu nhiên của chính bạn.',
    diceHow: 'Cách kiểm tra',
    diceCommitment: 'Cam kết (trước khi bạn cược): {value}',
    diceSecret: 'Bí mật (đã tiết lộ): {value}',
    diceSeed: 'Giá trị ngẫu nhiên của bạn: {value}',
    diceRule:
      'SHA-256(secret) phải bằng cam kết; kết quả tung là 16 bit đầu tiên của HMAC-SHA256(secret, giá trị của bạn).',
    rpsVerified:
      'Đã xác minh: nước đi và giá trị salt bot tiết lộ khớp với cam kết nó gửi trước khi bạn đi.',
    payoutClaimed:
      'Tiền thưởng: {amount}. Bot nói tin nhắn này mang khoản đó; điều này chưa được xác minh trên chuỗi.',
    payoutMissing:
      'Tiền thưởng: {amount}, nhưng tin nhắn này mang {carried}. Bạn chưa được trả đủ.',
    awaiting: 'Đang chờ bot tiết lộ ({seconds} s).',
    noAnswer:
      'Bot chưa trả lời sau {seconds} s. Tiền cược của bạn đang ở chỗ bot và chưa có gì được tiết lộ.',
  },
  raffleDraw: {
    verified: 'Kết quả bốc thăm khớp với cam kết hạt giống',
    failed: 'Xác minh thất bại: {reason}',
    explainerToggle: 'Điều này chứng minh gì?',
    explainerShows:
      'Chứng minh: người vận hành không đổi hạt giống sau khi cam kết, và người thắng được xác định từ danh sách người tham gia cùng hạt giống đó.',
    explainerNotShown:
      'Không chứng minh: người tham gia được liệt kê có thanh toán thật trên chuỗi, hay không có lượt tham gia nào bị bỏ sót.',
    explainerCountUnverified:
      'Vòng này không công bố quy mô, nên số người tham gia chưa được kiểm tra.',
  },
  persistentStorage: {
    tab: 'Bộ nhớ',
    heading: 'Lưu trữ bền vững',
    granted: 'Đã cấp quyền',
    notGranted: 'Chưa cấp quyền',
    unsupported: 'Không khả dụng',
    unknown: 'Đang kiểm tra…',
    explainGranted:
      'Trình duyệt đã đồng ý bảo vệ dữ liệu Frank đã lưu khỏi bị tự động xóa. Xóa dữ liệu trang web vẫn có thể xóa dữ liệu đó. Hãy giữ bản sao lưu tài khoản độc lập.',
    explainNotGranted:
      'Frank đã lưu dữ liệu trên thiết bị này. Quyền này bảo vệ thêm khỏi việc tự động xóa, không tăng dung lượng đĩa. Nếu không có quyền, trình duyệt có thể xóa dữ liệu đã lưu. Hãy giữ bản sao lưu tài khoản độc lập.',
    explainUnsupported:
      'Trình duyệt hoặc ngữ cảnh này không cung cấp bảo vệ khỏi việc tự động xóa. Frank vẫn có thể lưu dữ liệu nhưng trình duyệt có thể xóa dữ liệu đó. Hãy giữ bản sao lưu tài khoản độc lập.',
    request: 'Yêu cầu trình duyệt giữ dữ liệu của tôi',
    confirmSeed: 'Xác nhận cụm từ khôi phục của tôi',
    seedConfirmed: 'Đã xác nhận cụm từ khôi phục của bạn.',
    safariTip:
      'Safari trên Mac (macOS Sonoma 14 trở lên): chọn Tệp > Thêm vào Dock, mở Frank từ Dock rồi yêu cầu bảo vệ lại. Trên iPhone hoặc iPad, dùng Chia sẻ > Thêm vào Màn hình chính và mở Frank ở đó. Trình duyệt vẫn quyết định có cấp bảo vệ hay không; chỉ đánh dấu trang không bảo đảm điều này.',
    grantedToast: 'Trình duyệt đã cấp quyền lưu trữ bền vững.',
    declinedToast:
      'Trình duyệt chưa cấp bảo vệ khỏi việc tự động xóa. Dữ liệu vẫn được lưu. Xem hướng dẫn cài đặt bên dưới và thử lại; không bảo đảm sẽ được bảo vệ.',
  },
  blackjackP2p: {
    cancel: 'Hủy',
    challengeDealerReview: 'Người chơi kia chọn mức cược trong giới hạn này.',
    challengeBetLimit: 'Giới hạn cược',
    challengeBeforeBet:
      'Thao tác này mở một ván. Kiểm tra và xác nhận tiền cược sau khi người chia bài chấp nhận.',
    preparingChallenge: 'Đang chuẩn bị thách đấu…',
    betSummary: 'Tiền cược: {amount}',
    changeBet: 'Đổi',
    confirmBet: 'Cược {amount}',
    notDeliveredYet:
      'Bên kia chưa nhận được tin nhắn này: tin nhắn vẫn đang gửi.',
    notDelivered:
      'Bên kia không có tin nhắn này: tin nhắn chưa được gửi. {reason}',
    retry: 'Gửi lại',
    notNext:
      'Nước đi blackjack này đã được gửi hoặc không còn thực hiện được. Chưa gửi gì.',
    cardDealtN: 'Lá bài: {card}',
    playAgain: 'Chơi lại',
    challengeTitle: 'Thách đấu một ván blackjack',
    roleDealer: 'Tôi chia bài',
    rolePlayer: 'Tôi chơi, họ chia bài',
    maxBet: 'Mức cược tối đa',
    limitDealer:
      'Bạn có thể đề nghị tối đa {amount}: người chia bài phải đủ số dư riêng để trả một lần thắng khi nhân đôi cược (4× tiền cược).',
    limitPlayer:
      'Bạn có thể cược tối đa {amount}: số tiền bạn có thể chi tiêu hiện tại.',
    sendChallenge: 'Gửi thách đấu',
    challengeRefused:
      'Thách đấu này vượt quá khả năng chi trả từ số dư của bạn. Chưa gửi gì.',
    balanceUnknown: 'Chưa tải số dư của bạn.',
    enterAmount: 'Nhập số tiền lớn hơn không.',
    belowStamp: 'Số tiền không được thấp hơn mức tem tối thiểu ({amount}).',
    aboveOwnLimit:
      'Số tiền vượt quá khả năng chi trả của bạn (tối đa {amount}).',
    aboveMaxBet: 'Số tiền vượt quá mức cược tối đa của ván này ({amount}).',
    lineChallengeDealer:
      'Thách đấu blackjack: người gửi chia bài. Mức cược tối đa {amount}.',
    lineChallengePlayer:
      'Thách đấu blackjack: người gửi chơi, bạn chia bài. Mức cược tối đa {amount}.',
    lineAccept: 'Đã chấp nhận thách đấu. Mức cược tối đa {amount}.',
    line: {
      bet: 'Đã đặt cược: tem của tin nhắn này là tiền cược.',
      deal: 'Đã chia bài.',
      hit: 'Rút bài.',
      stand: 'Dừng rút.',
      double: 'Nhân đôi cược: tem của tin nhắn này là khoản cược thứ hai.',
      card: 'Đã chia lá bài.',
      reveal: 'Đã lật bài: tem của tin nhắn này là tiền thưởng, nếu có.',
      refund: 'Hoàn tiền: tem của tin nhắn này là tiền được trả lại.',
    },
    playerHand: 'Người chơi: {cards} ({total})',
    dealerHand: 'Người chia bài: {cards} ({total})',
    dealerShows: 'Người chia bài lộ: {card}',
    rowPlayer: 'Người chơi',
    rowDealer: 'Người chia bài',
    rowCard: 'Lá bài',
    wager: 'Tiền đang cược: {amount}',
    accept: 'Chấp nhận và chia bài',
    betAmount: 'Tiền cược của bạn (tối đa {max})',
    bet: 'Đặt cược',
    hit: 'Rút bài',
    stand: 'Dừng rút',
    double: 'Nhân đôi cược (+{amount})',
    payAndReveal: 'Trả {amount} và lật bài',
    refund: 'Hoàn {amount}',
    refundBet: 'Trả lại tiền cược ({amount}) thay vì chia bài',
    waitAccept: 'Đang chờ bên kia chấp nhận.',
    waitBet: 'Đang chờ tiền cược.',
    waitDealer: 'Đang chờ người chia bài.',
    waitPlayer: 'Đang chờ nước đi của người chơi.',
    waitReveal: 'Đang chờ người chia bài lật bài và thanh toán.',
    dealing: 'Đang chia bài…',
    verified:
      'Các lá bài được tạo từ cam kết của cả hai người chơi, đã kiểm tra trên thiết bị này.',
    badReveal:
      'Người chia bài gửi dữ liệu lật bài không khớp với cam kết. Ván chưa được quyết toán.',
    noSeed:
      'Thiết bị này không giữ hạt giống của ván nên không thể chia bài. Bạn có thể trả lại tiền cược.',
    noSeedPlayer:
      'Thiết bị này không giữ hạt giống của bạn cho ván nên không thể thực hiện nước đi. Hãy dùng thiết bị bạn đã đặt cược.',
    refundOwed: 'Người chia bài nợ bạn khoản hoàn tiền {amount}.',
    refunded: 'Người chia bài đã trả lại tiền cược ({amount}).',
    noPayout: 'Không trả thưởng.',
    paid: 'Người chia bài đã trả {amount}.',
    shortPaid: 'Người chia bài nợ {owed} nhưng đã trả {paid}.',
    outcome: {
      player: {
        player_win: 'Bạn thắng.',
        dealer_win: 'Người chia bài thắng.',
        push: 'Hòa: bạn nhận lại tiền cược.',
        player_blackjack: 'Blackjack! Bạn thắng theo tỷ lệ 3:2.',
      },
      dealer: {
        player_win: 'Người chơi thắng.',
        dealer_win: 'Bạn thắng.',
        push: 'Hòa: tiền cược được trả lại.',
        player_blackjack: 'Người chơi có blackjack và thắng theo tỷ lệ 3:2.',
      },
    },
  },
  a11y: {
    contactActions: 'Tùy chọn liên hệ cho {name}',
    openNavigation: 'Mở trình đơn điều hướng',
    addContact: 'Thêm liên hệ',
    addTopic: 'Thêm chủ đề',
    deleteTopic: 'Xóa chủ đề {topic}',
    deleteContact: 'Xóa liên hệ {name}',
    sendMessage: 'Gửi tin nhắn',
    voteUp: 'Bỏ phiếu ủng hộ',
    voteDown: 'Bỏ phiếu phản đối',
    forumRefresh: 'Làm mới diễn đàn',
    newPost: 'Bài đăng mới',
    forumSettings: 'Cài đặt diễn đàn',
    topicSettings: 'Cài đặt chủ đề',
    chatMenu: 'Tùy chọn trò chuyện',
    closeInfo: 'Quay lại trò chuyện',
    exitSelectMode: 'Thoát chế độ xóa tin nhắn',
    attachmentOptions: 'Tùy chọn tệp đính kèm',
    stampPayment: 'Thanh toán tem',
    messageActions: 'Hiện thao tác tin nhắn',
    replyToMessage: 'Trả lời tin nhắn',
    forwardMessage: 'Chuyển tiếp tin nhắn',
    messageInfo: 'Thông tin tin nhắn',
    deleteMessage: 'Xóa tin nhắn',
    resendMessage: 'Gửi lại tin nhắn',
    cancelReply: 'Hủy trả lời',
    scrollToLatest: 'Cuộn tới tin nhắn mới nhất',
    copyAddress: 'Sao chép địa chỉ',
    connectRelay: 'Kết nối máy chủ chuyển tiếp',
    choosePhoto: 'Chọn ảnh hồ sơ',
    previousAvatar: 'Ảnh đại diện trước',
    nextAvatar: 'Ảnh đại diện tiếp theo',
    openInExplorer: 'Mở giao dịch trong trình khám phá khối',
    copyTxHash: 'Sao chép mã băm giao dịch',
    backToForum: 'Quay lại diễn đàn',
    formatBold: 'Định dạng đậm',
    formatItalic: 'Định dạng nghiêng',
    formatHeading: 'Định dạng tiêu đề',
    formatQuote: 'Định dạng trích dẫn',
    formatCode: 'Định dạng mã',
    formatBullet: 'Định dạng danh sách dấu đầu dòng',
    formatLink: 'Chèn liên kết',
    attachPostImage: 'Đính kèm ảnh vào bài đăng',
    formatting: 'Định dạng',
  },
  leftDrawer: {
    noForums: 'Chưa tìm thấy diễn đàn nào.',
    settings: 'Cài đặt',
    chats: 'Tin nhắn trực tiếp',
    contacts: 'Liên hệ',
    forum: 'Diễn đàn',
    wallet: 'Ví',
    railLabel: 'Các mục thanh bên',
    chatsUnreadOne: 'Tin nhắn trực tiếp, {count} tin chưa đọc',
    chatsUnreadOther: 'Tin nhắn trực tiếp, {count} tin chưa đọc',
    contactsUnreadOne: 'Liên hệ, {count} tin chưa đọc',
    contactsUnreadOther: 'Liên hệ, {count} tin chưa đọc',
    loginSignUp: 'Đăng nhập / Đăng ký',
    welcome: 'Giới thiệu',
  },
  welcome: {
    title: 'Chào mừng đến với Frank',
    tagline: 'Tự do ngôn luận không miễn phí.',
    subtitle:
      'Nhắn tin riêng tư, chống thư rác bằng cơ chế kinh tế trên Monad.',
    introText:
      'Frank kết hợp danh tính mật mã không cần cấp phép với giá trị kinh tế thực. Người gửi trả cho sự chú ý, phát tin công khai đốt giá trị, và giao dịch ẩn giúp duy trì quyền riêng tư trong toàn mạng.',
    createAccount: 'Tạo tài khoản',
    createAccountSubtitle:
      'Tạo danh tính mật mã cục bộ trong vài giây mà không cần thông tin nhận dạng cá nhân.',
    browseForum: 'Duyệt diễn đàn',
    browseForumSubtitle:
      'Đọc chủ đề công khai và thảo luận cộng đồng mà không cần tài khoản.',
    readDocs: 'Đọc tài liệu',
    howItWorks: 'Cách Frank hoạt động',
    pillarFreeSpeechTitle: 'Tự do ngôn luận không miễn phí',
    pillarFreeSpeechDesc:
      'Khi nhắn tin không tốn phí, bot chiếm ưu thế và nền tảng kiểm duyệt. Frank thay người gác cổng bằng quy luật kinh tế: tin nhắn trực tiếp trả tiền cho người nhận, còn chủ đề công khai đốt giá trị.',
    pillarPrivacyTitle: 'Quyền riêng tư trong toàn mạng & DKSAP',
    pillarPrivacyDesc:
      'Thanh toán được chuyển tới địa chỉ ẩn dùng một lần được dẫn xuất. Giao dịch trông như chuyển tiền gas ngang hàng thông thường, tạo quyền riêng tư giữa đám đông trên toàn bộ blockchain.',
    pillarIdentityTitle: 'Danh tính tự chủ không cần thông tin cá nhân',
    pillarIdentityDesc:
      'Không cần số điện thoại, mã SMS hay email. Danh tính của bạn là cặp khóa secp256k1 cục bộ được dẫn xuất hoàn toàn trên thiết bị.',
    pillarRelayTitle: 'Máy chủ chuyển tiếp hộp thư liên kết',
    pillarRelayDesc:
      'Máy chủ chuyển tiếp định tuyến và lưu phong bì mã hóa đầu cuối, không bao giờ thấy nội dung tin nhắn rõ hoặc kiểm soát việc cấp danh tính.',
  },
  docs: {
    title: 'Tài liệu',
    header: 'Tài liệu & Giao thức',
    openInTab: 'Mở trong thẻ',
    iframeTitle: 'Tài liệu Frank',
  },
  walletPanel: {
    title: 'Các ví',
    mainWallet: 'Ví chính',
    renameWallet: 'Đổi tên ví',
    walletName: 'Tên ví',
    saveName: 'Lưu',
    cancel: 'Hủy',
    resetDefault: 'Đặt lại về mặc định',
    testnet: 'Mạng thử nghiệm',
    monad: 'Monad',
    monadTestnet: 'Monad Testnet',
    send: 'Gửi MON',
    receive: 'Nhận MON',
    sendMont: 'Gửi MONT',
    receiveMont: 'Nhận MONT',
    showSeed: 'Hiện cụm từ khôi phục',
    confirmSeed: 'Xác nhận cụm từ khôi phục',
    balanceLoading: 'Đang tải số dư…',
    relayUnavailable: 'Không khả dụng qua máy chủ chuyển tiếp này.',
    balanceUnavailable: 'Không thể tải số dư.',
    balanceUnsupported: 'Chưa hiển thị số dư cho mạng này.',
    walletUnsupported:
      'Chưa hỗ trợ mạng này. Không hiển thị địa chỉ vì ứng dụng không thể nhận biết tiền gửi tới đó.',
    notSupported: 'Không hỗ trợ',
    tokenBalancesLoading: 'Đang tải số dư token…',
    tokenBalancesUnavailable: 'Không thể tải số dư token.',
    tokenBalancesStale:
      'Không thể tải số dư token. Đang hiển thị số dư được biết gần nhất.',
    balanceStale: '{balance} (được biết gần nhất)',
    failedLoadAddress: 'Không thể dẫn xuất địa chỉ ví',
    receiveDiscoveryUnavailable:
      'Không thể kiểm tra địa chỉ nhận chưa dùng tiếp theo qua máy chủ chuyển tiếp. Thử lại khi có kết nối.',
    receiveAddressUnavailable:
      'Không có địa chỉ nhận cho tài khoản và mạng này. Hãy thử mở lại.',
    retryAddress: 'Thử lại địa chỉ',
    unableCopyAddress: 'Không thể sao chép địa chỉ Monad',
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
    receiveXec: 'Nhận XEC',
    receiveTxec: 'Nhận tXEC',
    sendAsset: 'Gửi {unit}',
    sendSol: 'Gửi SOL',
    receiveSol: 'Nhận SOL',
    sendTsol: 'Gửi tSOL',
    receiveTsol: 'Nhận tSOL',
    sendToContact: 'Gửi tới liên hệ',
    legacySend: 'Gửi kiểu cũ',
    avuDialogTitle: 'Đơn vị giá trị tùy ý (AVU)',
    avuDialogSubtitle: '1 AVU ≡ 1 Kilowatt-giờ (kWh) tính toán vật lý',
    avuDialogDesc:
      'Frank không hiển thị tiền pháp định trong giao diện. Số dư được so sánh bằng AVU, một đơn vị kế toán: 1 AVU bằng 1 kWh năng lượng. Lượng năng lượng tương ứng với một đơn vị giá trị được suy ra từ hoạt động đào bằng chứng công việc (giá, phần thưởng khối, độ khó và hiệu suất phần cứng đào của một rổ đồng tiền được đào), và giá trị AVU của một đồng tiền bằng giá nhân với con số đó. AVU không phải đồng tiền hay token; nó giúp so sánh hai đồng tiền qua một con số.',
    avuMemeHeading: 'Từ chối meme USD',
    avuMemeDesc:
      'Đô la Mỹ là một meme xã hội được duy trì bởi mặc định phần mềm và sắc lệnh ngân hàng trung ương. Từ chối hiển thị USD trong ví tự lưu ký phá vỡ sự độc quyền tâm lý đó và làm yếu meme, đưa tài sản trở lại nền tảng là các định luật nhiệt động lực học bất biến.',
    avuSupplyChainHeading: 'Gốc rễ của mọi chuỗi cung ứng',
    avuSupplyChainDesc:
      'Mọi hàng hóa vật chất—thực phẩm, nước sạch, nhà ở, chất bán dẫn và giao thông—về bản chất là năng lượng có tổ chức. Định giá bằng năng lượng vật lý giúp đo sức mua theo chi phí gốc của thực tại vật chất.',
    avuCpiHeading: 'Vượt qua CPI để thấy giá trị thực của đồng đô la',
    avuCpiDesc:
      'Chỉ số giá tiêu dùng (CPI) của chính phủ che khuất lạm phát qua thiên lệch thay thế và điều chỉnh chất lượng. Tờ $100 vẫn ghi "$100", che giấu sự mất giá. Năm 1960, $1 mua được khoảng 91 kWh điện công nghiệp Mỹ; năm 2025 chỉ mua khoảng 12 kWh (EIA). Theo dõi năng lượng theo thời gian cho thấy tốc độ mất giá của tiền pháp định.',
    avuOracleLessHeading: 'Thực sự "không cần oracle"',
    avuOracleLessDesc:
      'Khác với oracle DeFi truyền thống dựa vào nguồn dữ liệu bên thứ ba đáng tin cậy, độ khó và lịch phát hành của Proof-of-Work được các nút đầy đủ xác minh trực tiếp trên chuỗi và neo vào nhiệt động lực học cạnh tranh.',
    avuDialogClose: 'Đóng',
    avuDrawerHeader: '1 AVU ≡ 1 kWh (?)',
    avuRatesTitle: 'Giá trị của một đơn vị tính bằng AVU',
    avuRatesAsset: 'Tài sản',
    avuRatesRate: 'Tính toán vật lý (AVU / kWh)',
    tabBalance: 'Số dư & Chuyển tiền',
    priceHistoryTitle: 'Lịch sử giá {symbol}',
    priceHistoryAxisHash: 'AVU (Hash) trên mỗi {symbol}',
    priceHistoryAxisSpot: 'AVU (Spot) trên mỗi {symbol}',
    priceHistoryAxisGold: 'Ounce troy vàng trên mỗi {symbol}',
    priceHistoryHash: 'AVU (Hash)',
    priceHistorySpot: 'AVU (Spot)',
    priceHistoryGold: 'Vàng',
    priceHistoryPoints: '{count} quan sát giá kể từ {first}.',
    priceHistoryCoverage:
      'Có {count} quan sát giá từ {first} đến {last}. Khoảng thời gian yêu cầu: {range}.',
    priceHistorySinglePoint:
      'Chỉ có một quan sát giá trong khoảng này; không vẽ đường.',
    priceHistoryGoldUnavailable:
      'Không có giá vàng gần đây kèm ngày cho các quan sát này.',
    priceHistorySource: 'Nguồn giá: {source}.',
    priceHistoryBenchmarkUnavailable:
      'Không có định giá {benchmark} cho đồng tiền này trong khoảng này.',
    avuReferenceTitle: 'Giá trị AVU bằng đô la Mỹ',
    avuReferenceAxis: 'USD trên mỗi AVU',
    avuReferenceHash: '1 AVU (Hash)',
    avuReferenceSpot: '1 AVU (Spot)',
    avuReferenceNoHistory: 'Không có lịch sử tham chiếu AVU trong khoảng này.',
    avuReferenceSinglePoint:
      'Một chuẩn tham chiếu chỉ có một quan sát; không vẽ đường cho chuẩn đó.',
    avuReferencePointCount: '{count} quan sát',
    avuReferenceMethod: 'Cách tính AVU',
    avuReferenceMethodText:
      'AVU (Hash) định giá năng lượng qua đào bằng chứng công việc; AVU (Spot) dùng giá điện bán buôn. Giá trị đô la của mỗi loại là nghịch đảo của năng lượng trên mỗi đô la. Các đầu vào thiếu vẫn không có giá trị.',
    aboutAvu: 'Về AVU',
    tabHistory: 'Lịch sử',
    historyEmpty: 'Chưa ghi nhận hoạt động trên mạng này.',
    historyPending: 'Đang chờ và chưa giải quyết',
    historyUndated: 'Không có ngày',
    backToWallet: 'Quay lại ví',
    avuReferenceMeasurement:
      'Một AVU đại diện cho một kilowatt-giờ. Các đường này cho thấy giá trị bằng đô la Mỹ dựa trên phép đo đào và điện bán buôn.',
    avuReferenceSampling:
      'Phép đo đào dùng giá đồng tiền, doanh thu đào và hashrate quan sát được, hiệu suất phần cứng và trọng số vốn hóa thị trường. Đầu vào lịch sử gồm trung bình tháng và thay đổi có ngày; mỗi giá trị giữ nguyên đến quan sát tiếp theo. Thay đổi trên đường có thể do bất kỳ đầu vào nào, không chỉ hashrate.',
    tabParity: 'Lịch sử giá',
    tabSwap: 'Hoán đổi tức thì',
    swapUnavailable: 'Không có hoán đổi tức thì',
    swapUnavailableDescription:
      'Chưa hỗ trợ hoán đổi. Không có báo giá hay giao dịch.',
    assetsAndTokens: 'Tài sản & Token',
    nativeCoin: 'Đồng tiền gốc',
    splToken: 'Token SPL',
    tokenMint: 'Địa chỉ mint token',
    tokenContract: 'Hợp đồng token',
    recentActivity: 'Hoán đổi gần đây',
    noRecentActivity: 'Chưa có hoán đổi trên chuỗi này.',
    swapAction: 'Hoán đổi',
    viewInExplorer: 'Xem trong trình khám phá',
    avuTooltip:
      '1 AVU ≡ 1 kWh (3.6 MJ) tính toán vật lý. Chuẩn nhiệt động lực học không thể giả mạo của sức mua thực.',
    avuHashLabel:
      'AVU_hash: năng lượng trên mỗi đơn vị giá trị, từ hoạt động đào',
    avuHashNote:
      'Trung bình trên rổ đồng tiền được đào, theo trọng số vốn hóa thị trường với Bitcoin tối đa 60%: {weights}. Litecoin và Dogecoin được đào chung và tính là một mục. Hiệu suất phần cứng được tuyển chọn: ước tính của Cambridge về máy đang thực sự chạy SHA-256, máy tốt nhất đang bán cho scrypt và RandomX. Máy tốt nhất hiệu quả hơn cả đội máy, nên hai mục đó cho giá trị trên mỗi kWh cao hơn số liệu của đội máy tương đương.',
    avuSpotLabel:
      'AVU_spot: điện bán buôn, được định giá như cách đào định giá năng lượng',
    avuSpotNote:
      'Ở 1 AVU, lưới điện và hoạt động đào tương đương nhau. Giá: giá ngày tới trung bình của mỗi vùng trong {window} ngày đến {latest}, các vùng có trọng số bằng nhau: {regions}.',
    avuUnitLabel: 'Đơn vị',
    avuUnitNote:
      'Đơn vị kế toán, không phải đồng tiền hay token: không nắm giữ hay hoán đổi bất kỳ thứ gì bằng AVU.',
    avuUnavailable: 'Không khả dụng',
    sourceEfficiency:
      'Hiệu suất phần cứng (được tuyển chọn, không đo trực tiếp): {sources}.',
    avuHashVsSpotNote:
      'Thu nhập từ một kWh đào so với chi phí một kWh bán buôn. Hai giá trị nên xấp xỉ nhau.',
    avuHashVsSpotLabel: 'Thu nhập đào so với giá điện lưới',
    avuHashStale: 'Đã cũ: đầu vào cũ nhất cách đây {age}.',
    avuHashLeftOutEfficiency: 'không có số liệu hiệu suất phần cứng',
    avuHashLeftOutPrice: 'không có giá',
    avuHashLeftOutChain: 'không có thống kê chuỗi',
    avuHashLeftOut: 'Bỏ qua: {coins}.',
    avuHashUnavailableNote:
      'Không tính được AVU_hash: không đồng tiền nào trong rổ có cả giá và thống kê chuỗi. Không hiển thị giá trị AVU cho đến khi có một đồng đáp ứng.',
    avuPriceFreshNote: 'Đã nhận giá cách đây {age}.',
    avuPriceStaleNote: 'Đã cũ: nhận giá gần nhất cách đây {age}.',
    avuStalePrice: '{rate} (cách đây {age})',
    resetZoom: 'Đặt lại mức thu phóng',
    chartGoldAvu: 'Vàng (AVU trên mỗi ounce)',
    rangeAll: 'TẤT CẢ',
    range5Y: '5 năm',
    range1Y: '1 năm',
    range30D: '30 ngày',
    range7D: '7 ngày',
    range24H: '24 giờ',
    rangeNetworks: 'Các mạng',
    chartNoteNoHistory: 'Chưa có lịch sử cho khoảng này nên không vẽ đường.',
    chartNoteNetworks:
      'Thu nhập của một kWh đào trên mỗi mục trong rổ, bằng AVU, cùng trọng số của mục: giá × phần thưởng khối của thợ đào ÷ số phép băm kỳ vọng mỗi khối × số phép băm mỗi kWh, định giá theo rổ. Tỷ lệ phần trăm so sánh với toàn rổ (1 AVU trên mỗi kWh).',
    chartNoteNetworksUnavailable: 'Không tính được AVU_hash nên không vẽ gì.',
    sourcesTitle: 'Phương pháp & Nguồn dữ liệu',
    sourceUnit:
      'AVU: 1 AVU = 1 kWh. AVU_hash là lượng năng lượng tương ứng với một đơn vị giá trị, lấy trung bình trên rổ đồng tiền được đào theo vốn hóa thị trường với Bitcoin tối đa 60%; với mỗi mục, thu nhập mỗi kWh = giá × phần thưởng khối của thợ đào ÷ số phép băm kỳ vọng mỗi khối × số phép băm mỗi kWh. Mỗi giá trị AVU bằng giá nhân AVU_hash.',
    avuHashValue: '{used} trên {total} mục trong rổ',
    avuFeesExcluded:
      'Không có phí đào cho một phần ước tính này; các đầu vào đó chỉ dùng trợ cấp khối cho thợ đào.',
    avuHashEstimated: 'Một mục dựa trên số liệu phần cứng ước tính.',
    avuSpotValue: 'Một kWh bán buôn có giá {avu} AVU',
    avuSpotStale: 'Chưa làm mới: giá gần nhất cách đây {age}.',
    avuSpotNotPositive:
      'Giá bán buôn trung bình không lớn hơn không nên không có nghịch đảo.',
    avuSpotNoData: 'Chưa nhận được giá điện bán buôn.',
    avuUnitValue: '1 AVU = 1 kWh',
    avuNoPrice:
      'Oracle không có giá cho đồng tiền này nên không có giá trị AVU.',
    avuTestnetValue: '{rate} · mạng thử nghiệm',
    chartGridAvu: 'Một kWh điện bán buôn (AVU)',
    chartNoteLines:
      '{count} điểm từ {first}. Mỗi điểm được tính cho ngày tương ứng bằng cùng công thức với số liệu hôm nay, từ giá, thống kê chuỗi, hiệu suất phần cứng và giá điện có hiệu lực lúc đó. Không có điểm tại nơi thiếu đầu vào.',
    chartNoteNoTokenPrice: 'Không có lịch sử giá {symbol} trong khoảng này.',
    chartNoteEstimated:
      'Hiệu suất phần cứng Monero trước ASIC đầu tiên (tháng Chín năm 2023) là ước tính: bộ xử lý máy tính để bàn ở giới hạn công suất gói, không tính phần còn lại của máy tính.',
    chartNoteTestnet:
      'Đồng tiền mạng thử nghiệm được định giá theo giá đồng tiền mạng chính.',
    chartNoteNoFeed: 'Chưa nhận được gì từ oracle nên không vẽ gì.',
    sourcePrices: 'Giá: {sources}.',
    sourceChains:
      'Độ khó, phần thưởng khối và nguồn cung: {sources}. Độ khó Dogecoin là số liệu 24 giờ.',
    sourceElectricity: 'Điện bán buôn: {sources}.',
    sourceGold:
      'Vàng: Dữ liệu giá hàng hóa Ngân hàng Thế giới (Pink Sheet), theo năm, định giá bằng AVU_hash giữa năm.',
    avuSpotRegionsLeftOut:
      'Không có trong số liệu này vì quá ít giá gần đây: {regions}.',
    avuSpotRegionLast: '{region} (tính gần nhất ngày {day})',
    avuHashVsSpotLess:
      'Đào trả thấp hơn giá điện lưới {percent}% trên mỗi kWh.',
    avuHashVsSpotMore: 'Đào trả cao hơn giá điện lưới {percent}% trên mỗi kWh.',
    sourceEcashShare:
      'Thợ đào eCash nhận {share} phần thưởng khối kể từ {since} (trước đó {previous}), đọc từ chuỗi.',
    activeTokenCardTitle: '{symbol} bằng AVU',
    inspectingDate: 'Đang xem',
    latestValue: 'Mới nhất',
  },
  chatList: {
    senderPrefix: '{name}: {text}',
    noContactMessage: 'Thêm liên hệ từ ngăn phía trên...',
    youPrefix: 'Bạn: {text}',
    themPrefix: 'Họ: {text}',
    balance: 'Số dư',
    balanceStale: '(được biết gần nhất)',
    directMessages: 'Tin nhắn trực tiếp',
    composeEmail: 'Soạn email',
    openingConversation: 'Đang mở cuộc trò chuyện…',
    selectChatOrAddContact:
      'Chọn cuộc trò chuyện hoặc thêm liên hệ để bắt đầu nhắn tin.',
    searchPlaceholder: 'Tìm tin nhắn, chủ đề, liên hệ… (⌘K)',
    clearSearch: 'Xóa tìm kiếm',
    noSearchResults: 'Không tìm thấy tin nhắn hoặc cuộc trò chuyện phù hợp.',
    screenerFilterLabel: 'Sàng lọc ({count}) · {value}',
    screenerFilterEmpty: 'Không có yêu cầu trả phí từ người lạ đang chờ.',
    allConversationsFilter: 'Tất cả',
    screenerBannerTitle:
      'Bộ sàng lọc thu phí: Người gửi đã trả {value} tiền tem để liên hệ với bạn',
    screenerApprove: 'Chấp nhận & Thêm liên hệ',
    screenerReplyOnce: 'Trả lời một lần',
    screenerDismissKeepStamp: 'Bỏ qua & Giữ tem',
  },
  selfChat: {
    you: 'Bạn',
  },
  outgoing: {
    sending: 'Đang gửi…',
    paymentPending:
      'Thanh toán đang chờ, sẽ thử lại. Bạn sẽ không bị tính tiền lần nữa.',
    paymentQueued: 'Đang chờ tin nhắn trước hoàn tất. Tin này sẽ được gửi sau.',
    paymentChecking: 'Đang kiểm tra trạng thái thanh toán…',
    waitingForPreviousPayment: 'Đang chờ khoản thanh toán trước được xác nhận…',
    waitingForChain: 'Đã xếp hàng: không thể kết nối mạng.',
    waitingBlocks:
      'Đang chờ thêm {blocks} khối sau khoản thanh toán trước rồi mới thanh toán…',
    paymentSent: 'Đã gửi',
    paymentInMempool: 'Tem tin nhắn trong mempool',
    paymentPaid: 'Đã thanh toán tem',
    paymentReverted: 'Tem tin nhắn bị hoàn tác, đang thanh toán lại',
    paymentRepaid: 'Tem bị hoàn tác, đã thanh toán lại',
    paymentFailed: 'Tem tin nhắn thất bại',
    paymentUnsent: 'Chưa thanh toán tem tin nhắn',
    reasonUnreachable: 'Không thể kết nối máy chủ.',
    reasonUnavailable: 'Máy chủ chuyển tiếp này không cung cấp nhắn tin.',
    reasonRejected: 'Máy chủ chuyển tiếp đã từ chối.',
    reasonInterrupted: 'Bị gián đoạn trước khi được gửi.',
    reasonUnverified: 'Không thể xác nhận việc chuyển phát.',
    reasonRecovered: 'Trong lúc đó, một tin nhắn trước đã được chuyển phát.',
    reasonInsufficientFunds: 'Không đủ tiền để gửi tin nhắn này.',
    reasonRecipientUnregistered:
      'Người nhận chưa đăng ký trên máy chủ chuyển tiếp này.',
    reasonStampBelowFee:
      'Phí mạng đã tăng cao hơn tem này trước khi gửi. Chưa thanh toán gì. Thử lại sẽ gửi với mức tem tối thiểu hiện tại.',
    reasonError: 'Không thể gửi tin nhắn.',
    retry: 'Thử lại',
    retryHint:
      'Thử lại sẽ gửi lại cùng khoản thanh toán khi nó còn hợp lệ. Chỉ tạo khoản thanh toán mới khi khoản cũ không còn hợp lệ.',
    discard: 'Bỏ',
    discardConfirmTitle: 'Bỏ tin nhắn?',
    discardConfirmMessage:
      'Thao tác này xóa tin nhắn khỏi cuộc trò chuyện. Nếu thanh toán vẫn đang chờ, tin nhắn vẫn có thể được chuyển phát.',
    discardFailedConfirmMessage:
      'Thao tác này xóa tin nhắn thất bại khỏi cuộc trò chuyện. Chưa có tiền nào được chi.',
    sendAgainTitle: 'Gửi lại?',
    sendAgainUnverified:
      'Chúng tôi không thể xác nhận khoản thanh toán đầu tiên đã được chuyển phát hay chưa. Gửi lại có thể khiến bạn bị tính tiền lần thứ hai.',
    sendAgainRecovered:
      'Một tin nhắn đang chờ trước đó đã được chuyển phát khi tin này đang gửi. Gửi lại tin này như tin nhắn mới?',
    sendAgain: 'Gửi lại',
  },
  mailboxStatus: {
    directory: {
      'device-clock':
        'Nhắn tin đang tắt: ngày giờ trên thiết bị có vẻ sai. Hãy kiểm tra đồng hồ; đang thử lại.',
      'account-unavailable':
        'Nhắn tin đang tắt: không thể mở tài khoản này để nhắn tin. Đang thử lại.',
      'relay-unreachable':
        'Nhắn tin đang tắt: không thể kết nối máy chủ để công bố tài khoản. Đang thử lại.',
      'relay-rejected':
        'Nhắn tin đang tắt: máy chủ từ chối lưu mục địa chỉ tài khoản. Đang thử lại.',
      'relay-misconfigured':
        'Nhắn tin đang tắt: máy chủ không mô tả chính nó đúng cách nên không thể công bố tài khoản. Đang thử lại.',
      'entry-refused':
        'Nhắn tin đang tắt: máy chủ giữ mục xung đột hoặc không hợp lệ cho tài khoản của bạn. Đang thử lại.',
      'storage':
        'Nhắn tin đang tắt: thiết bị không lưu được các bản ghi danh bạ. Đang thử lại.',
    },
    unavailable:
      'Dịch vụ nhắn tin không khả dụng: máy chủ chuyển tiếp này không cung cấp nhắn tin nên bạn sẽ không nhận được tin nhắn.',
    unreachable:
      'Không thể kết nối máy chủ. Bạn có thể không nhận được tin nhắn; đang thử lại.',
    rateLimited: 'Máy chủ yêu cầu giảm tốc độ. Sẽ sớm thử lại.',
    unauthorized: 'Máy chủ từ chối đăng nhập nhắn tin của bạn. Đang thử lại.',
  },
  chatMessage: {
    notInContacts: 'Không có trong danh bạ của bạn',
    openSender: 'Mở hồ sơ của {name}',
    noPayloadFound: 'Không tìm thấy nội dung tải của tin nhắn',
    failedToSend: 'Gửi thất bại',
    showActions: 'Hiện thao tác tin nhắn',
    replyMessage: 'Trả lời tin nhắn',
    forwardMessage: 'Chuyển tiếp tin nhắn',
    infoMessage: 'Thông tin tin nhắn',
    deleteMessage: 'Xóa tin nhắn',
  },
  chatMessageMenu: {
    reply: 'Trả lời',
    forward: 'Chuyển tiếp',
    copy: 'Sao chép văn bản',
    stampTransaction: 'Giao dịch tem',
    resend: 'Gửi lại',
    discard: 'Bỏ',
    delete: 'Xóa',
    messageCopied: 'Đã sao chép tin nhắn vào bảng nhớ tạm',
  },
  chatListMenu: {
    openChat: 'Mở trò chuyện',
    viewProfile: 'Xem hồ sơ',
    copyAddress: 'Sao chép địa chỉ',
    mute: 'Tắt thông báo',
    unmute: 'Bật lại thông báo',
    deleteChat: 'Xóa cuộc trò chuyện',
  },
  notifications: {
    addressCopied: 'Đã sao chép địa chỉ vào bảng nhớ tạm.',
    insufficientStamp: 'Tem quá nhỏ, người nhận sẽ không được thông báo.',
    seedCopied: 'Đã sao chép cụm từ khôi phục vào bảng nhớ tạm.',
    sentTransaction: 'Đã gửi giao dịch',
    unexpectedError: 'Đã xảy ra lỗi. Vui lòng thử lại.',
    viewAction: 'Xem',
  },
  chatRightDrawer: {
    deleteContactAndConversations: 'Xóa liên hệ và các cuộc trò chuyện',
    stampPrice: 'Giá tem',
    sendLotus: 'Gửi Lotus',
    notifications: 'Thông báo',
    clearHistory: 'Xóa lịch sử',
    deleteChat: 'Xóa trò chuyện',
    unknownContact: 'Không rõ',
    usernameReassigned:
      'Bạn đã thêm liên hệ này với tên {username}. Tên người dùng đó hiện thuộc tài khoản khác. Liên hệ này vẫn là tài khoản bạn đã thêm, và tin nhắn vẫn gửi tới tài khoản đó.',
  },
  sendStealthDialog: {
    nativeBalance: 'Số dư đồng tiền gốc',
    insufficientFunds:
      'Không đủ số dư tài sản hoặc đồng tiền gốc cho khoản thanh toán này và phí mạng.',
    insufficientBalance: 'Số tiền vượt quá số dư khả dụng',
    assetLabel: 'Tài sản và mạng',
    reviewBtnLabel: 'Kiểm tra thanh toán',
    checkingQuote: 'Đang kiểm tra số dư và phí…',
    recipientAmount: 'Số tiền người nhận',
    nativeFee: 'Phí mạng',
    feeCeiling: 'Phí mạng tối đa',
    messageStampFee: 'Phí mạng tin nhắn ước tính',
    messageStamp: 'Tem tin nhắn',
    preparing: 'Đang chuẩn bị thanh toán ẩn danh: {amount}',
    sendStealthTo: 'Gửi thanh toán ẩn danh tới',
    subtitle:
      'Thanh toán từ ví của bạn tới địa chỉ dùng một lần mà chỉ liên hệ này có thể chi tiêu',
    balanceLabel: 'Khả dụng cho khoản thanh toán này:',
    amountHint: 'Số tiền cần trả',
    amountPlaceholder: '0.0',
    memoHint: 'Ghi chú gửi kèm thanh toán (không bắt buộc)',
    memoPlaceholder: 'Nhập ghi chú...',
    sendBtnLabel: 'Gửi',
    cancelBtnLabel: 'Hủy',
    sent: 'Đã gửi thanh toán',
    pending:
      'Đã lưu thanh toán. Tin nhắn kèm theo vẫn đang được chuyển phát; khoản tiền được thanh toán khi tin nhắn đến. Đừng gửi lại.',
    notSent: 'Không thể thực hiện thanh toán. Chưa gửi gì.',
    messageEnded:
      'Đã lưu thanh toán nhưng không thể chuyển phát tin nhắn kèm theo. Mở trò chuyện với liên hệ này và thử lại tin nhắn: chưa thanh toán gì và không khoản nào bị trả hai lần.',
    tooLarge:
      'Khoản thanh toán này lớn hơn mức một khoản thanh toán cho liên hệ có thể mang (khoảng {max} {unit}); hãy gửi thành nhiều phần.',
  },
  offerSwapDialog: {
    title: 'Đề nghị hoán đổi nguyên tử với',
    subtitle: 'Hoán đổi nguyên tử xuyên chuỗi không cần tin cậy',
    youPay: 'Bạn đề nghị (trả)',
    youReceive: 'Bạn nhận',
    offeredChain: 'Chuỗi đề nghị',
    requestedChain: 'Chuỗi yêu cầu',
    offerBtnLabel: 'Đề nghị hoán đổi',
    cancelBtnLabel: 'Hủy',
  },
  chatMessageSwap: {
    notAvailableYet:
      'Chưa có hoán đổi nguyên tử. Không thể khóa, nhận hay hoàn tiền từ đây.',
    title: 'Đề nghị hoán đổi nguyên tử',
    offered: 'Đề nghị',
    for: 'Đổi lấy',
    accept: 'Chấp nhận hoán đổi',
    cancel: 'Hủy đề nghị',
    lockDeposit: 'Nạp & Khóa {amount} {asset}',
    acceptAndLock: 'Chấp nhận & Khóa {amount} {asset}',
    claimFunds: 'Nhận {amount} {asset}',
    refundDeposit: 'Hoàn tiền nạp',
    activeOnOtherDevice: 'Đang hoạt động trên {device}',
    takeOverActive: 'Dùng tại đây',
    viewTx: 'Xem giao dịch {chain}',
    statusUnfunded: 'Chưa nạp tiền',
    statusLocked: 'Đã khóa trong ký quỹ',
    statusWithdrawn: 'Đã rút',
    statusRefunded: 'Đã hoàn tiền',
    statusExpired: 'Đã hết hạn',
    processing: 'Đang xử lý...',
  },
  balanceBreakdown: {
    open: 'Số dư này nằm ở đâu',
    main: 'Tài khoản chính',
    mainNote: 'Địa chỉ nạp tiền của bạn: địa chỉ hiển thị bên dưới.',
    profile: 'Địa chỉ hồ sơ',
    profileNote: 'Tiền gửi tới địa chỉ trên hồ sơ của bạn.',
    received: 'Khoản thanh toán đã nhận ({count})',
    receivedNote:
      'Các khoản thanh toán và tem người khác gửi bạn, mỗi khoản ở địa chỉ dùng một lần riêng, đã xác nhận trên mạng.',
    other: 'Tài khoản gửi',
    otherNote:
      'Ví dành riêng tiền trong các tài khoản của nó để trả cho tin nhắn tiếp theo. Là một phần của số dư phía trên.',
    total: 'Số dư',
    yours:
      'Mỗi tài khoản này đều thuộc ví này và được khôi phục từ cụm từ khôi phục của bạn.',
    unavailable: 'Hiện chưa đọc được các tài khoản.',
  },
  heldContactPayments: {
    title: 'Thanh toán cho liên hệ đang tiến hành',
    finish: 'Hoàn tất',
    state: {
      prepared:
        'Đã ký. Đang chờ tin nhắn được chuyển phát; tiền đang được giữ lại.',
      delivered: 'Đã chuyển phát tin nhắn. Thanh toán đang được gửi lên chuỗi.',
      failed:
        'Không thể chuyển phát tin nhắn kèm theo. Thanh toán được giữ lại; tiền đang được giữ lại.',
    },
  },
  chatMessageStealth: {
    outboundState: {
      unknown: 'Chưa kiểm tra',
      planned: 'Đang chuẩn bị',
      prepared: 'Đang chờ',
      delivered: 'Đang chờ',
      paid: 'Đã thanh toán',
      failed: 'Chuyển phát khoản chuyển tiền thất bại',
      released: 'Đã hủy trước khi gửi',
    },
    title: 'Thanh toán ẩn danh',
    sentTitle: 'Thanh toán ẩn danh đã gửi',
    receivedTitle: 'Thanh toán ẩn danh đã nhận',
    viewInExplorer: 'Xem giao dịch trong trình khám phá khối',
    viewTransaction: 'Xem giao dịch',
    sent: 'Đã gửi',
    pending: 'Đang chờ',
    received: 'Đã nhận',
    unverified: 'Chưa kiểm tra',
    pendingHint:
      'Đang chờ chuỗi ghi nhận khoản thanh toán này. Khoản này chưa có trong số dư của bạn.',
    spendableHint: 'Có trong số dư có thể chi tiêu',
    spentHint: 'Đã nhận và sau đó đã chi tiêu',
    unverifiedHint:
      'Ví chưa kiểm tra khoản thanh toán này với dữ liệu trên chuỗi.',
    statedAmount: 'Người gửi khai báo {stated}; chuỗi ghi nhận {actual}.',
    notReceived: 'Chưa nhận thanh toán',
    notReceivedHint:
      'Người gửi tuyên bố đã thanh toán nhưng chuỗi không ghi nhận khoản chuyển đó. Khoản này không có trong số dư. Ví tiếp tục kiểm tra.',
    failed: 'Thanh toán thất bại',
    failedHint:
      'Khoản thanh toán này không bao giờ có thể đến: giao dịch thất bại hoặc bị thay thế. Khoản này không có trong số dư.',
    claimedAmount: 'theo lời người gửi',
    notReceivedNotice:
      'Khoản thanh toán người gửi tuyên bố ({amount}) chưa đến.',
  },
  setup: {
    loginOrSignUp: 'Đăng nhập/Đăng ký',
    welcome: 'Chào mừng',
    welcomeToStampChat: 'Chào mừng đến với Frank!',
    networkTitle: 'Monad Testnet',
    testnetDisclaimer:
      'Frank chạy trên mạng thử nghiệm Monad. Mọi giao dịch dùng MON thử nghiệm, không có giá trị tiền tệ thực tế. Tuyệt đối không gửi tiền thật hoặc tài sản mạng chính.',
    economicModelTitle: 'Thao tác trả phí & Chi phí',
    costsDisclaimer:
      'Thao tác gửi đi phát sinh phí mạng và tiền tem. Phí hoặc số tiền tem thực tế luôn hiển thị trước khi bạn xác nhận.',
    directMessagesTitle: 'Tin nhắn trực tiếp',
    directMessagesDesc:
      'Trả trực tiếp cho người nhận dưới dạng tem hộp thư, ngăn thư rác và bù đắp việc chuyển phát.',
    topicActionsTitle: 'Bài đăng & Phiếu diễn đàn',
    topicActionsDesc:
      'Được đốt (hủy vĩnh viễn trên chuỗi) để công bố bài đăng chủ đề công khai hoặc ghi nhận phiếu.',
    fundingTitle: 'Nạp tiền thử nghiệm',
    fundingDesc:
      'Tài khoản mới tự động nhận MON thử nghiệm từ vòi demo. Bạn cũng có thể xem địa chỉ và nhận tiền thử nghiệm từ màn hình Nhận sau khi thiết lập.',
    eulaDisclaimer:
      'Frank là phần mềm thử nghiệm. Có thể có lỗi làm chậm tin nhắn hoặc gây mất tiền. Chỉ dùng số tiền bạn chấp nhận mất.',
    eulaYouUnderstand:
      'Khi nhấp "Đồng ý", bạn thừa nhận Frank được cung cấp "nguyên trạng", không có bảo đảm nào, dù rõ ràng hay ngụ ý.',
    setupWallet: 'Thiết lập nhân vật',
    eula: 'EULA',
    deposit: 'Nạp Lotus',
    settings: 'Cài đặt',
    back: 'Quay lại',
    seedWarning:
      'Ghi lại cụm từ khôi phục và giữ an toàn. Nếu bạn mất cụm từ, không ai có thể khôi phục tài khoản.',
    searchingRelay: 'Đang tìm dữ liệu máy chủ chuyển tiếp hiện có...',
    networkErrorRelayDied: 'Lỗi mạng: Kết nối máy chủ chuyển tiếp đã ngắt. ',
    networkErrorRelayUnexpected:
      'Lỗi mạng: Máy chủ chuyển tiếp gặp lỗi không mong đợi.',
    requestingPayment: 'Đang yêu cầu thanh toán...',
    sendingPayment: 'Đang gửi thanh toán...',
    uploadingMetaData: 'Đang tải siêu dữ liệu lên...',
    openingInbox: 'Đang mở hộp thư...',
    profileImageLargeError: 'Ảnh hồ sơ quá lớn, hãy chọn ảnh nhỏ hơn.',
    continue: 'Tiếp tục',
    finish: 'Hoàn tất',
    generatingWallet: 'Đang tạo ví...',
    gatheringBalances: 'Đang thu thập số dư...',
    watchingWallet: 'Đang theo dõi ví...',
    searchingExistingMetaData: 'Đang tìm siêu dữ liệu đăng ký hiện có...',
    errorContactRegistry: 'Không thể liên hệ hệ thống đăng ký',
    storedSeedMismatch:
      'Không thể thay cụm từ khôi phục trên thiết bị này từ màn hình này.',
    replaceNotAcknowledged:
      'Không thể thay tài khoản này khi chưa xác nhận việc thay thế.',
    accountSetupNext: 'Tiếp',
    depositStepNext: 'Tiếp',
  },
  accountStep: {
    newAccount: 'Tài khoản mới',
    importAccount: 'Nhập tài khoản',
    copyRecoveryPhrase: 'Sao chép cụm từ khôi phục',
    refreshRecoveryPhrase: 'Tạo cụm từ khôi phục mới',
    resumeNotice:
      'Thiết bị này đã lưu cụm từ khôi phục nhưng tài khoản chưa có tên. Xác nhận cụm từ và chọn tên để hoàn tất. Cụm từ không bị thay trừ khi bạn nhập cụm từ khác đã có.',
    confirmStoredFirst:
      'Trước tiên hãy xác nhận hoặc sao chép cụm từ khôi phục đã lưu.',
    importDifferentPhrase: 'Tôi đã có cụm từ khôi phục khác',
    importDifferentContinue: 'Tiếp tục nhập',
    invalidWordCount: 'Cụm từ khôi phục phải có 12, 15, 18, 21 hoặc 24 từ.',
    unrecognizedWords: 'Không nhận ra một hoặc nhiều từ. Kiểm tra lỗi gõ.',
    invalidChecksum:
      'Tổng kiểm tra của cụm từ khôi phục không hợp lệ. Kiểm tra thứ tự và cách viết các từ.',
  },
  seedConfirm: {
    unavailable:
      'Không thể xác nhận vì thiết bị này không có bộ tạo số ngẫu nhiên an toàn. Quay lại và thử lại hoặc dùng trình duyệt khác.',
    stepTitle: 'Xác nhận cụm từ',
    title: 'Xác nhận cụm từ khôi phục của bạn',
    instructions:
      'Nhập các từ được yêu cầu từ cụm từ khôi phục bạn đã ghi. Tài khoản chỉ được tạo khi các từ khớp.',
    wordLabel: 'Từ #{n}',
    check: 'Kiểm tra câu trả lời của tôi',
    wordError: 'Từ #{n} không khớp',
    recheck:
      'Một số từ không khớp với cụm từ khôi phục. Kiểm tra lại các vị trí từ này: {positions}.',
    success: 'Đã xác nhận cụm từ khôi phục. Bạn có thể hoàn tất thiết lập.',
    showPhrase: 'Hiện lại cụm từ khôi phục của tôi',
    hidePhrase: 'Ẩn cụm từ khôi phục của tôi',
    phraseLabel: 'Cụm từ khôi phục của bạn, theo thứ tự',
  },
  backupReminder: {
    regionLabel: 'Nhắc sao lưu cụm từ khôi phục',
    message:
      'Bạn chưa xác nhận cụm từ khôi phục. Xác nhận đã lưu cụm từ để luôn có thể khôi phục tài khoản.',
    confirm: 'Xác nhận ngay',
    dismiss: 'Để sau',
  },
  replaceGuard: {
    title: 'Bạn đã có tài khoản trên thiết bị này',
    intro:
      'Thiết lập lại sẽ thay thế tài khoản đó. Cụm từ khôi phục là cách duy nhất để lấy lại tài khoản cùng tiền trong đó.',
    introNameOnly:
      'Thiết lập lại sẽ thay thế hồ sơ đó. Hồ sơ này không có cụm từ khôi phục hay tiền trong ví trên thiết bị này.',
    confirmed: 'Đã xác nhận cụm từ khôi phục hiện tại.',
    cancel: 'Hủy và quay lại tài khoản của tôi',
    confirmCurrent: 'Xác nhận cụm từ khôi phục hiện tại',
    replaceToggle: 'Thay thế tài khoản này',
    warning:
      'Thay thế tài khoản này sẽ xóa cụm từ khôi phục, tên và hồ sơ hiện tại khỏi thiết bị. Nếu chưa sao lưu cụm từ, bạn có thể không khôi phục được tài khoản và bất kỳ khoản tiền nào.',
    warningNameOnly:
      'Thay thế tài khoản này sẽ xóa tên và hồ sơ hiện tại khỏi thiết bị.',
    typeLabel: 'Nhập {word} để tiếp tục',
    word: 'THAY THẾ',
    mismatch: 'Không khớp. Nhập chính xác từ yêu cầu để tiếp tục.',
    replace: 'Thay thế tài khoản này',
  },
  newContactDialog: {
    lookup: {
      'clock':
        'Ngày giờ trên thiết bị có vẻ sai nên không kiểm tra được địa chỉ này. Kiểm tra đồng hồ và thử lại.',
      'not-published':
        'Địa chỉ này chưa tự công bố nên không thể nhận tin nhắn. Hãy yêu cầu chủ sở hữu mở ứng dụng một lần.',
      'unreachable':
        'Không thể kết nối máy chủ để tra cứu địa chỉ này. Thử lại sau giây lát.',
      'refused':
        'Máy chủ trả về mục cho địa chỉ này nhưng mục không được địa chỉ đó ký, đã hết hạn hoặc xung đột với mục trước đó. Mục này không được dùng.',
      'messaging-off':
        'Tài khoản của bạn vẫn đang được công bố. Có thể thêm liên hệ khi bật nhắn tin.',
    },
    newContact: 'Liên hệ mới',
    startConversation: 'Bắt đầu cuộc trò chuyện',
    startConversationBtn: 'Bắt đầu cuộc trò chuyện',
    addContact: 'Thêm liên hệ',
    addAndChat: 'Thêm & Trò chuyện',
    contactAdded: 'Đã thêm liên hệ',
    composeEmail: 'Soạn email',
    enterBitcoinCashAddress: 'Nhập địa chỉ (0x...) hoặc địa chỉ email',
    enterAddress: 'Nhập địa chỉ (0x...) hoặc địa chỉ email',
    enterAddressOrEmail:
      'Nhập địa chỉ (0x...), tên liên hệ, tên người dùng hoặc email',
    existingContacts: 'Liên hệ hiện có',
    existingContact: 'Liên hệ hiện có',
    clearContact: 'Bỏ chọn liên hệ',
    topicOptional: 'Chủ đề (không bắt buộc)',
    topicPlaceholder: 'ví dụ: kế-hoạch-dự-án, yêu-cầu, hóa-đơn',
    loading: 'Đang tra cứu liên hệ',
    notFound: 'Không tìm thấy',
    found: 'Đã tìm thấy liên hệ: {name}',
    ownAddress:
      'Đây là địa chỉ của chính bạn. Bạn không thể thêm chính mình vào liên hệ.',
    showMyQr: 'Hiện mã QR của tôi',
    startEmail: 'Bắt đầu email',
    startEmailThread:
      'Bắt đầu luồng email tới {email} (qua Frank Email Gateway)',
    startEmailThreadAffordance:
      'Bắt đầu luồng email tới {email} (qua Frank Email Gateway)',
    sendEmailViaGateway: 'Soạn và gửi email đi qua Frank Email Gateway',
  },
  emailThread: {
    gatewayBadge: '✉️ Cầu nối email (qua Frank Gateway)',
    unverifiedBadge: '⚠️ Email P2P trực tiếp (Chưa xác minh)',
    collapseAll: 'Thu gọn tất cả',
    expandAll: 'Mở rộng tất cả',
    participants: 'Người tham gia',
    messageSingle: 'tin nhắn',
    messagePlural: 'tin nhắn',
    to: 'Tới',
    cc: 'Cc',
    bcc: 'Bcc',
    attachmentsCount: 'Tệp đính kèm ({count}):',
    attachFiles: 'Đính kèm tệp',
    reply: 'Trả lời',
    replyAll: 'Trả lời tất cả',
    replySender: 'Trả lời người gửi',
    hideCc: '- CC',
    showCc: '+ CC',
    hideBcc: '- BCC',
    showBcc: '+ BCC',
    addRecipient: 'Thêm người nhận...',
    addCcRecipient: 'Thêm người nhận Cc...',
    addBccRecipient: 'Thêm người nhận Bcc...',
    subjectLabel: 'Chủ đề:',
    subjectPlaceholder: 'Chủ đề',
    writeMessagePlaceholder: 'Viết nội dung email...',
    writeReplyPlaceholder: 'Viết email trả lời...',
    quoteOriginal: 'Trích dẫn bản gốc',
    preview: 'Xem trước',
    edit: 'Sửa',
    send: 'Gửi',
    sendTooltip: 'Gửi qua Frank Email Gateway (Ctrl+Enter)',
    newDraftTitle: 'Luồng email mới',
    newDraftSubtitle:
      'Soạn tin nhắn bên dưới. Frank sẽ chuyển qua Frank Email Gateway tới người nhận bằng email Internet thông thường.',
    newEmail: 'Email gửi đi mới',
    followUp: 'Bản nháp tiếp nối',
    stampExplanation:
      'Chuyển phát qua Frank Email Gateway. Tem trả cho việc gửi đi của cổng và bằng chứng chống thư rác.',
    formatBold: 'Đậm',
    formatItalic: 'Nghiêng',
    formatHeading: 'Tiêu đề',
    formatQuote: 'Trích dẫn',
    formatCode: 'Mã',
    formatBullet: 'Danh sách dấu đầu dòng',
    formatLink: 'Liên kết',
    showQuotedText: 'Hiện văn bản trích dẫn',
    hideQuotedText: 'Ẩn văn bản trích dẫn',
  },
  newTopicDialog: {
    newTopic: 'Thêm chủ đề',
    enterTopic: 'Nhập chủ đề...',
    topicNameMinLength: 'Vui lòng dùng ít nhất 3 ký tự',
    topicNameRules: 'Chỉ cho phép ký tự A-Z, a-z, 0-9 và dấu chấm',
    add: 'Thêm',
    cancel: 'Hủy',
  },
  topicDrawer: {
    offering: 'Đề nghị:',
    filter: 'Bộ lọc:',
  },
  SettingPanel: {
    newContact: 'Liên hệ mới',
    contacts: 'Liên hệ',
    sendMonad: 'Gửi MON',
    receiveMonad: 'Nhận MON',
    profile: 'Hồ sơ',
    settings: 'Cài đặt',
    changeLog: 'Nhật ký thay đổi',
    showSeed: 'Hiện hạt giống',
    confirmSeed: 'Xác nhận cụm từ khôi phục',
    panelLabel: 'Cài đặt',
  },
  receiveBitcoinDialog: {
    walletStatus: 'Trạng thái ví',
    balanceUnavailable: 'Không thể tải số dư. Đang thử lại.',
    noFundsHint:
      'Số dư của bạn là 0. Ứng dụng dùng MON thử nghiệm, không có giá trị thực. Vòi demo tự nạp tiền cho hồ sơ mới; nếu sau một phút vẫn chưa nhận được, hãy nhờ người vận hành demo gửi MON thử nghiệm tới địa chỉ bên dưới.',
    close: 'Đóng',
    addressCopied: 'Đã sao chép địa chỉ vào bảng nhớ tạm',
    failedLoadBalance: 'Không thể tải số dư ví',
    unableCopyAddress: 'Không thể sao chép địa chỉ Monad',
  },
  walletHistory: {
    transfers: 'Chuyển tiền',
    to: 'Tới',
    contract: 'Hợp đồng',
    details: 'Chi tiết',
    intended:
      'Đây là số tiền được yêu cầu. Chưa xác nhận toàn bộ khoản thanh toán.',
    dateUnknown: 'Không ghi nhận ngày cho khoản chuyển tiền này.',
    transaction: 'Giao dịch {number}',
    status: {
      confirmed: 'Đã xác nhận',
      included: 'Đã gửi',
      reverted: 'Đã hoàn tác',
      partial: 'Đã xử lý một phần',
      pending: 'Đang chờ',
      missing: 'Đang chờ mạng',
      unknown: 'Đang kiểm tra thanh toán',
      cancelled: 'Đã hủy',
    },
    memberStatus: {
      'included-success': 'Đã xác nhận',
      'included-revert': 'Đã hoàn tác',
      'pending': 'Đang chờ',
      'missing': 'Chưa có trên mạng',
      'unknown': 'Chưa xác nhận',
    },
  },
  nativeOperation: {
    title: 'Kết quả chuyển tiền',
    listTitle: 'Chuyển đồng tiền gốc',
    intendedAmount: 'Số tiền dự định cho người nhận',
    processing: 'Đang kiểm tra kết quả khoản chuyển tiền ban đầu…',
    included: 'Đã gửi trên {network}.',
    reverted:
      'Giao dịch cho người nhận bị hoàn tác trên {network}. Có thể đã trả phí mạng.',
    partial:
      'Một số giao dịch cấp vốn đã được đưa vào khối trên {network}; chưa ghi nhận khoản thanh toán cho người nhận được đưa vào khối.',
    pending: 'Trong mempool trên {network}: đã gửi, đang chờ khối.',
    missing:
      '{network} chưa có khoản chuyển tiền này. Đang gửi lại cùng khoản chuyển.',
    watching:
      'Đang theo dõi mạng. Trạng thái tự cập nhật khi khoản chuyển tiền vào khối.',
    unknown:
      'Chưa xác định được kết quả thanh toán trên {network}. Tiền có thể đã được chuyển.',
    cancelled: 'Đã hủy khoản chuyển tiền chưa ký.',
    feecomplete: 'Phí mạng quan sát được: {amount} {unit}',
    feepartial: 'Phí quan sát được đến nay (một phần): {amount} {unit}',
    feeunknown: 'Không có phí mạng quan sát được.',
    block: 'Khối {block}',
    syncNotShared: 'Chưa chia sẻ với các thiết bị khác của bạn.',
    syncShared: 'Đã gửi tới các thiết bị khác của bạn.',
    syncFailed:
      'Chưa thể gửi tới các thiết bị khác. Sẽ thử lại; thanh toán không bị ảnh hưởng.',
    recoveryUnavailable: 'Hiện không thể khôi phục.',
    reviewHeld: 'Việc kiểm tra này không thể gửi khoản thanh toán khác.',
    unsupported: 'Không có lịch sử chuyển đồng tiền gốc cho ví này.',
    unavailable: 'Không có bằng chứng chuyển đồng tiền gốc.',
    empty: 'Không có khoản chuyển đồng tiền gốc được lưu giữ.',
    viewTransfer: 'Xem khoản chuyển tiền',
    contractCall: 'Gọi hợp đồng (hoán đổi hoặc phê duyệt hoán đổi)',
    back: 'Quay lại',
    stale:
      'Tài khoản hoặc trang đã thay đổi. Xem khoản chuyển tiền ban đầu từ ví của nó.',
  },
  sendAddressDialog: {
    sendToAddress: 'Gửi tới địa chỉ',
    enterBitcoinCashAddress: 'Nhập địa chỉ (0x...)',
    enterAmount: 'Nhập số tiền ({unit})',
    cancel: 'Hủy',
    send: 'Gửi',
    review: 'Kiểm tra',
    reviewTitle: 'Kiểm tra khoản chuyển tiền',
    network: 'Mạng',
    recipient: 'Người nhận',
    amount: 'Số tiền',
    estimatedFee: 'Phí ước tính',
    feeUnavailable: 'Không khả dụng',
    refused: 'Mạng từ chối giao dịch này. Chưa gửi gì.',
    feeChanged:
      'Phí mạng đã tăng. Chưa gửi gì. Kiểm tra phí mới và xác nhận lại.',
    maxTotal: 'Số tiền + phí mạng',
    maxTotalWithFee: '{amount} {unit} (+ phí mạng)',
    irreversibleWarning:
      'Giao dịch blockchain không thể đảo ngược. Kiểm tra người nhận và mạng trước khi xác nhận.',
    editTransfer: 'Sửa',
    confirmAndSend: 'Xác nhận & Gửi',
    definitelyNotBroadcast: 'Giao dịch chưa được phát đi. Chưa chuyển tiền.',
    potentiallyBroadcast:
      'Giao dịch đã ký ({txHash}) và có thể đã được phát đi. Kiểm tra số dư hoặc trạng thái giao dịch trước khi thử lại.',
    invalidTransfer: 'Nhập địa chỉ Monad và số tiền MON hợp lệ.',
    failedSendTransaction: 'Không thể gửi giao dịch Monad',
  },
  sendContactDialog: {
    available: 'Khả dụng cho thanh toán này: {amount}',
    title: 'Gửi tới liên hệ',
    selectContact: 'Chọn liên hệ',
    searchContacts: 'Tìm liên hệ...',
    selectedContact: 'Liên hệ đã chọn',
    changeContact: 'Đổi',
    noContactsFound: 'Không tìm thấy liên hệ',
    enterAmount: 'Nhập số tiền ({unit})',
    amount: 'Số tiền',
    memo: 'Ghi chú (không bắt buộc)',
    reviewTransfer: 'Kiểm tra khoản chuyển tiền',
    recipient: 'Người nhận',
    stealthNotice:
      'Trả tới địa chỉ dùng một lần mà chỉ liên hệ này có thể chi tiêu. Tin nhắn cho ví của họ biết tiền nằm ở đâu.',
    confirmAndSend: 'Xác nhận & Gửi',
    sending: 'Đang gửi...',
    cancel: 'Hủy',
    back: 'Quay lại',
    edit: 'Sửa',
    invalidAmount: 'Vui lòng nhập số tiền hợp lệ',
    missingSpendKey:
      'Liên hệ chưa đăng ký khóa công khai cho thanh toán ẩn danh',
    sent: 'Đã gửi thanh toán',
    pending:
      'Đã lưu thanh toán. Tin nhắn kèm theo vẫn đang được chuyển phát; khoản tiền được thanh toán khi tin nhắn đến. Đừng gửi lại.',
    notSent: 'Không thể thực hiện thanh toán. Chưa gửi gì.',
    messageEnded:
      'Đã lưu thanh toán nhưng không thể chuyển phát tin nhắn kèm theo. Mở trò chuyện với liên hệ này và thử lại tin nhắn: chưa thanh toán gì và không khoản nào bị trả hai lần.',
    tooLarge:
      'Khoản thanh toán này lớn hơn mức một khoản thanh toán cho liên hệ có thể mang (khoảng {max} {unit}); hãy gửi thành nhiều phần.',
  },
  contactBookDialog: {
    contacts: 'Liên hệ',
    search: 'Tìm...',
    close: 'Đóng',
    myQrCode: 'Mã QR danh tính của tôi',
  },
  contactItem: {
    address: 'Địa chỉ',
    inboxPrice: 'Giá hộp thư',
    notFound: 'Không tìm thấy',
  },
  settings: {
    title: 'Cài đặt',
    back: 'Quay lại',
    openMenu: 'Mở trình đơn',
    appearance: 'Giao diện',
    networking: 'Kết nối mạng',
    contactRefreshInterval: 'Khoảng làm mới liên hệ (phút)',
    contactRefreshIntervalHint:
      'Khoảng thời gian giữa các lần cập nhật liên hệ (phút)',
    darkMode: 'Chế độ tối',
    themeTitle: 'Đá chủ đề Signet',
    saveSettings: 'Lưu',
    savedNotification: 'Đã lưu cài đặt',
    cancelSettings: 'Hủy',
    languageSelectorCaption: 'Ngôn ngữ',
    networkSettings: 'Cài đặt mạng & Cổng',
    emailGatewayAddress: 'Địa chỉ cổng email',
    emailGatewayFee:
      'Phí tem email đến: 0.01 MONT. Cổng trả chi phí gửi đi và xác minh chống thư rác.',
    emailGatewayRelayLabel: 'Cổng của máy chủ chuyển tiếp:',
    emailGatewayChanged:
      'Máy chủ chuyển tiếp hoặc danh tính cổng email đã thay đổi. Kiểm tra địa chỉ mới trước khi dùng.',
    emailGatewayChecking:
      'Đang kiểm tra cổng email của máy chủ chuyển tiếp này…',
    emailGatewayUnavailable:
      'Máy chủ chuyển tiếp này không có cổng email khả dụng. Không thể gửi email trừ khi bạn đặt địa chỉ cụ thể.',
    emailGatewayOverrideHint: 'Địa chỉ ghi đè tùy chọn cho mạng đã chọn',
    acceptRelayGateway: 'Chấp nhận cổng của máy chủ chuyển tiếp',
    useRelayGateway: 'Dùng cổng của máy chủ chuyển tiếp',
    resetDefault: 'Đặt lại về mặc định',
    save: 'Lưu',
    gateways: 'Các cổng',
    networkModeTitle: 'Môi trường mạng & Các chuỗi',
    testnetMode: 'Chế độ mạng thử nghiệm',
    testnetActiveBanner:
      'Mạng thử nghiệm đang hoạt động trên Monad và mọi mạng quyết toán phụ.',
    mainnetActiveBanner:
      'Mạng chính đang hoạt động. Giao dịch và quyết toán dùng tài sản thật.',
    mainnetLockedBanner: 'Hiện đang khóa việc chuyển sang mạng chính.',
    supportedChainsTitle: 'Mạng quyết toán được hỗ trợ',
    chainSendReceive: 'Gửi và nhận',
    chainUnsupported: 'Không hỗ trợ',
    notificationFeeThresholdAvu: 'Ngưỡng phí thông báo (AVU)',
    notificationFeeThresholdAvuHint:
      'Giá trị tem tối thiểu bằng AVU (1 AVU = 1 kWh, ví dụ 0.01 AVU) để kích hoạt thông báo đẩy (tin nhắn dưới ngưỡng vẫn được chuyển âm thầm vào hộp thư)',
    allowContactNotificationBypass:
      'Cho phép liên hệ có token đánh thức gửi thông báo không cần tem',
    coldVaultTitle: 'Kho ví lạnh tự động quét tiền',
    coldVaultSubtitle:
      'Tự động quét tiền tem và thanh toán đến vượt trần ví nóng trực tiếp (1 bước) tới địa chỉ kho MetaMask, Phantom hoặc Ledger bên ngoài.',
    coldVaultEnabled: 'Bật tự động quét vào ví lạnh',
    coldVaultAddressLabel: 'Địa chỉ kho bên ngoài (EVM / Solana)',
    coldVaultAddressHint:
      'Địa chỉ ví phần cứng hoặc trình duyệt (0x... hoặc Solana base58) nhận tiền dư được quét',
    coldVaultMaxHotBalanceLabel: 'Trần số dư lưu động ví nóng tối đa (MON)',
    coldVaultMaxHotBalanceHint:
      'Mặc định: 1,500 MON (~150 AVU, ngưỡng kích hoạt trễ +20% tại 1,800 MON)',
    languageAutomatic: 'Tự động (ngôn ngữ trình duyệt)',
  },
  profile: {
    name: 'Tên hiển thị',
    seedEntry: 'Cụm từ khôi phục',
    importSeed: 'Khôi phục ký ức cũ',
    invalidSeed: 'Đó không phải cụm từ khôi phục hợp lệ.',
    nameHint: 'Tên hiển thị cho người khác',
    enterSeed: 'Nhập cụm từ khôi phục...',
    nameBlank: 'Nhập tên: không được để trống hoặc chỉ chứa khoảng trắng.',
    nameTooLong: 'Tên quá dài: dùng tối đa {max} ký tự.',
    nameForbiddenCharacters:
      'Tên chứa ký tự không được phép. Bỏ ngắt dòng và ký tự điều khiển khác.',
    nameInvalidUnicode:
      'Tên chứa ký tự không hợp lệ. Xóa ký tự đó hoặc dán văn bản thuần.',
    bio: 'Tiểu sử',
    bioHint: 'Tiểu sử ngắn hiển thị cho người khác',
    uploadAvatar: 'Tải ảnh đại diện lên',
    username: 'Tên người dùng',
    usernameHint:
      'Tên duy nhất (3–32 ký tự, chữ thường, số, dấu gạch nối, dấu gạch dưới)',
    invalidUsername:
      'Tên người dùng phải dài 3–32 ký tự và chỉ chứa chữ thường, số, dấu gạch nối và dấu gạch dưới.',
    usernameTaken: 'Tên người dùng đó đã có người dùng. Hãy chọn tên khác.',
    usernameNotPublished:
      'Tài khoản chưa được công bố trên máy chủ chuyển tiếp. Chờ đến khi bật nhắn tin rồi lưu lại.',
    usernameUnavailable:
      'Không thể đặt tên người dùng: không kết nối được máy chủ chuyển tiếp hoặc yêu cầu bị từ chối. Hãy thử lại.',
    usernameConfirmedTitle: 'Máy chủ chuyển tiếp đã xác nhận tên người dùng',
    usernameNoWallet:
      'Mở khóa tài khoản trước khi đặt tên người dùng: yêu cầu phải được tài khoản ký.',
    usernameNotHeld:
      'Tên người dùng đã lưu không thuộc tài khoản này trên máy chủ chuyển tiếp. Mở hồ sơ để xem lý do.',
    usernameStillHeld:
      'Tài khoản này giữ {username}. Không thể từ bỏ tên người dùng: tên vẫn thuộc bạn cho đến khi bạn nhận tên khác.',
    nameStartsWithAt:
      "Tên không được bắt đầu bằng {'@'}. Đặt tên người dùng trong trường Tên người dùng.",
    location: 'Vị trí',
    locationHint: 'Nơi bạn ở (không bắt buộc)',
    links: 'Liên kết & Mạng xã hội',
    addLink: 'Thêm liên kết',
    removeLink: 'Gỡ liên kết',
    linkType: 'Nền tảng / Loại',
    linkUrl: 'URL hoặc tên tài khoản',
    linkLabel: 'Nhãn (không bắt buộc)',
    linkTypeWebsite: 'Trang web / Blog',
    linkTypeX: 'X (Twitter)',
    linkTypeGithub: 'GitHub',
    linkTypeNostr: 'Nostr',
    linkTypeTelegram: 'Telegram',
    linkTypeDiscord: 'Discord',
    linkTypeOther: 'Khác',
    unnamed: 'Chưa đặt tên',
    accountType: 'Loại tài khoản',
    accountTypeHint:
      'Khai báo tài khoản đại diện cho cá nhân, bot, dịch vụ hay tổ chức',
    accountTypePerson: 'Cá nhân',
    accountTypeBot: 'Bot',
    accountTypeService: 'Dịch vụ',
    accountTypeOrganization: 'Tổ chức',
    botRole: 'Vai trò bot / dịch vụ',
    botRoleHint: 'Vai trò chuyên biệt của tài khoản tự động này',
    botRoleGeneric: 'Chung',
    botRoleAssistant: 'Trợ lý AI',
    botRoleFaucet: 'Vòi cấp tiền',
    botRoleGame: 'Trọng tài / Người chia bài',
    botRoleBridge: 'Cầu nối',
    botRoleMerchant: 'Người bán / Cửa hàng',
    botRoleModerator: 'Người kiểm duyệt',
    botRoleAnnouncer: 'Người thông báo',
    badgeOfficial: 'Chính thức',
    badgeOfficialBot: 'Bot chính thức',
    badgeOfficialService: 'Dịch vụ chính thức',
    badgeBot: 'Bot',
    badgeService: 'Dịch vụ',
    badgeAi: 'AI chính thức',
    badgeFaucet: 'Vòi cấp tiền chính thức',
    badgeGame: 'Trò chơi',
    badgeOfficialGame: 'Trò chơi chính thức',
    badgeMerchant: 'Người bán',
    badgeOfficialMerchant: 'Người bán chính thức',
    badgeModerator: 'Người kiểm duyệt',
    badgeOfficialModerator: 'Người kiểm duyệt chính thức',
    badgeAnnouncer: 'Người thông báo',
    badgeOfficialAnnouncer: 'Người thông báo chính thức',
    badgeBridge: 'Cầu nối',
    badgeOfficialBridge: 'Cầu nối chính thức',
  },
  clearHistoryDialog: {
    cancel: 'Hủy',
    clear: 'Xóa',
    message: 'Bạn có chắc muốn xóa toàn bộ lịch sử trò chuyện với',
  },
  deleteContactDialog: {
    message: 'Xóa {name} và mọi cuộc trò chuyện với liên hệ này?',
    cancel: 'Hủy',
    delete: 'Xóa liên hệ và các cuộc trò chuyện',
    failed: 'Không thể xóa xong liên hệ này. Vui lòng thử lại.',
  },
  deleteChatDialog: {
    cancel: 'Hủy',
    delete: 'Xóa',
    message: 'Bạn có chắc muốn xóa toàn bộ lịch sử trò chuyện với',
  },
  deleteMessageDialog: {
    cancel: 'Hủy',
    delete: 'Xóa',
    message: 'Bạn có chắc muốn xóa tin nhắn này?',
  },
  imageDialog: {
    close: 'Đóng',
  },
  profileDialog: {
    accountChanged: 'Tài khoản đã thay đổi. Mở lại hồ sơ trước khi lưu.',
    cancel: 'Hủy',
    update: 'Cập nhật',
    republish: 'Công bố lại',
    avatarTooLarge: 'Ảnh đại diện hồ sơ quá lớn, hãy chọn ảnh nhỏ hơn.',
    unableContactRelay: 'Không thể liên hệ máy chủ chuyển tiếp.',
    pushingProfile: 'Đang gửi hồ sơ mới...',
    profile: 'Hồ sơ',
    savedNotification: 'Đã cập nhật hồ sơ',
    identityQr: 'Danh tính & QR',
    viewIdentityQr: 'Chia sẻ / QR kết bạn',
    identityHeading: 'Danh tính Frank của bạn',
    identitySubheading:
      'Chia sẻ mã QR hoặc địa chỉ này với bạn bè để họ thêm bạn vào danh bạ và gửi tin nhắn mã hóa.',
    identityAddressLabel: 'Địa chỉ danh tính (cho nhắn tin & liên hệ)',
    identityExplanation:
      'Địa chỉ chuẩn này được công bố lên máy chủ chuyển tiếp danh bạ. Bạn bè thêm địa chỉ này để bắt đầu trò chuyện trực tiếp mã hóa đầu cuối với bạn.',
    receiveVsIdentityTitle: 'Địa chỉ danh tính và địa chỉ nhận',
    receiveVsIdentityBody:
      'Địa chỉ danh tính dùng cho liên hệ, nhắn tin và hiển thị hồ sơ diễn đàn. Để nhận tiền, token hoặc gas, hãy dùng địa chỉ nhận.',
    receiveAddressHint:
      'Bạn muốn nhận đồng tiền hoặc token? Địa chỉ nhận được quản lý trong Ví.',
    goToWallet: 'Đi tới Ví',
    scanPrompt: 'Quét để thêm liên hệ trên Frank',
  },
  seedPhraseDialog: {
    seedPhrase: 'Cụm từ khôi phục',
    close: 'Đóng',
    cancel: 'Hủy',
    warningTitle: 'Cảnh báo bảo mật',
    warningBody:
      'Đảm bảo không ai nhìn màn hình. Cẩn thận với chia sẻ màn hình, người nhìn trộm qua vai, ảnh chụp màn hình và lịch sử bảng nhớ tạm.',
    disclosureText:
      'Bất kỳ ai có cụm từ khôi phục đều có thể truy cập và đánh cắp vĩnh viễn toàn bộ tiền và tin nhắn của bạn.',
    revealButton: 'Hiện cụm từ khôi phục',
    hideButton: 'Ẩn',
    copyButton: 'Sao chép',
    copied: 'Đã sao chép!',
    copiedToast: 'Đã sao chép cụm từ khôi phục vào bảng nhớ tạm',
    keepPrivateNotice: 'Giữ riêng tư. Đừng chia sẻ hoặc chụp màn hình.',
  },
  transactionDialog: {
    stealthPayment: 'Thanh toán ẩn danh',
    valueUnavailable: 'Chưa xác định được giá trị giao dịch',
    transactionUnavailable: 'Không thể giải mã giao dịch',
    baseUnits: 'đơn vị cơ sở',
    stampState: {
      pending: 'Đã gửi',
      mempool: 'Trong mempool',
      paid: 'Đã thanh toán',
      repaid: 'Đã thanh toán lại',
      reverted: 'Đã hoàn tác',
      failed: 'Thất bại',
      unsent: 'Chưa thanh toán',
    },
    backingTransactions: 'Giao dịch bảo chứng',
    totalStampPayment: 'Tổng tiền tem thanh toán',
    stampPaymentN: 'Thanh toán tem {n}',
    sentTo: 'Tới {address}',
    txId: 'Mã giao dịch',
    txType: 'Loại',
    txAddress: 'Địa chỉ',
    txAmount: 'Số tiền',
    copyTxHash: 'Sao chép mã băm giao dịch',
    localChainNotice: 'Hệ thống cục bộ / lớp mô phỏng chuỗi',
    txHashCopied: 'Đã sao chép mã băm giao dịch vào bảng nhớ tạm',
  },
  about: {
    appName: 'Frank',
    title: 'Giới thiệu',
    menu: 'Giới thiệu và giấy phép',
    tagline: 'Nhắn tin riêng tư, chống thư rác bằng cơ chế kinh tế cho Monad.',
    checkForUpdates: 'Kiểm tra cập nhật',
    checkingForUpdates: 'Đang kiểm tra cập nhật…',
    alreadyLatestVersion: 'Bạn đang dùng phiên bản mới nhất.',
    reloadAndClearCache: 'Tải lại & xóa bộ nhớ đệm',
    clearCacheConfirm: 'Bạn có chắc muốn xóa bộ nhớ đệm và tải lại?',
    frankTitle: 'Về Frank',
    frankIntro:
      'Frank là ứng dụng nhắn tin mật mã phi tập trung, tự chủ dành cho blockchain Monad, tiếp nối và phát triển giao thức Stamp. Nó kết hợp danh tính mật mã không cần cấp phép với cơ chế kinh tế chống thư rác thực sự.',
    frankAccounts:
      'Tài khoản là cặp khóa secp256k1 không cần cấp phép được tạo hoàn toàn trên thiết bị. Frank không yêu cầu số điện thoại, địa chỉ email hay nhà cung cấp tài khoản trung tâm.',
    stampTitle: 'Giao thức Stamp: Tự do ngôn luận không miễn phí',
    stampIntro:
      'Thay vì dựa vào người gác cổng tập trung hoặc giám sát để lọc thư rác, giao thức Stamp đưa động lực kinh tế trực tiếp vào giao tiếp.',
    stampDMsTitle: 'Tin nhắn trực tiếp & Chuyển phát trả phí',
    stampDMsDesc:
      'Mỗi tin nhắn trực tiếp mang giao dịch tem trên chuỗi trả thẳng cho người nhận qua địa chỉ ẩn dùng một lần được dẫn xuất. Người gửi trả cho sự chú ý của bạn, loại bỏ hoàn toàn thư rác không được yêu cầu.',
    stampTopicsTitle: 'Phát tin chủ đề & Trọng số đốt',
    stampTopicsDesc:
      'Bài đăng chủ đề công khai và phiếu cộng đồng đốt MON vào địa chỉ không thể chi tiêu, tạo trọng lượng kinh tế có thể chứng minh cho thảo luận công khai mà không cần kiểm duyệt tập trung.',
    stampPrivacyTitle: 'Mã hóa đầu cuối',
    stampPrivacyDesc:
      'Mọi nội dung tải tin nhắn đều được mã hóa đầu cuối. Các máy chủ chuyển tiếp CashWeb liên kết xác thực giao dịch tem và lưu phong bì mà không bao giờ thấy nội dung rõ.',
    badgeMonad: 'Monad',
    badgeStamp: 'Giao thức Stamp',
    badgeEncrypted: 'Mã hóa đầu cuối',
    badgePermissionless: 'Danh tính không cần cấp phép',
    thirdPartyTitle: 'Phần mềm bên thứ ba',
    dklsName: 'Thư viện ký hai bên DKLs23 (Silence Laboratories)',
    dklsModified:
      'Frank có phiên bản sửa đổi của thư viện DKLs23 từ Silence Laboratories. Dự án Frank đã sửa thư viện vào {date}, một cách độc lập và không có sự tham gia nào từ Silence Laboratories.',
    dklsChanges:
      'Thay đổi: mỗi phiên ký được gắn với một tin nhắn, và bổ sung ký trước thích ứng hai bên.',
    dklsNonCommercial:
      'Thành phần này chỉ được dùng cho mục đích phi thương mại. Giấy phép MIT của Frank không áp dụng cho thành phần này.',
    dklsSource:
      'Mã nguồn thư viện sửa đổi nằm trong kho Frank, tại thư mục {path}.',
    licenseHeading: 'Giấy phép thư viện DKLs23',
    licenseIntro:
      'Toàn văn giấy phép, gồm điều kiện và tuyên bố miễn trừ trách nhiệm, do Silence Laboratories công bố (chỉ bằng tiếng Anh):',
  },
  swap: {
    interfaceFee: 'Phí Frank ({rate})',
    venueNote:
      'Bản triển khai thử nghiệm do {maintainer} vận hành, không phải Uniswap Labs',
    pay: 'Bạn trả',
    payToken: 'Token bạn dùng để trả',
    receive: 'Bạn nhận',
    receiveToken: 'Token bạn nhận',
    switchTokens: 'Đổi chỗ hai token',
    available: 'Khả dụng',
    balance: 'Số dư',
    max: 'TỐI ĐA',
    otherAccounts: 'Còn {amount} trong các tài khoản khác của ví này',
    testToken: 'token thử nghiệm',
    reviewMove:
      'Trước tiên sẽ chuyển {amount} {unit} từ các tài khoản khác vào tài khoản chính để thực hiện hoán đổi.',
    reviewStale:
      'Không thể làm mới giá. Đang thử lại; bạn có thể xác nhận khi giá được cập nhật.',
    progressRecovering: 'Đang hoàn tất giao dịch trước đó từ ví này…',
    rate: 'Tỷ giá',
    priceImpact: 'Tác động giá',
    poolFee: 'Phí pool',
    minimumReceived: 'Nhận tối thiểu',
    networkFee: 'Phí mạng',
    networkFeeKnown: '{fee} {unit}',
    networkFeePartial:
      '{fee} {unit} cho các phê duyệt; biết phí hoán đổi sau khi chúng được xác nhận',
    reviewPaySame:
      'Bạn trả {amount} {asset} + {fee} {unit} phí mạng = {total} {unit}.',
    reviewPayOther: 'Bạn trả {amount} {asset} + {fee} {unit} phí mạng.',
    reviewPayPartial:
      'Bạn trả {amount} {asset} + {fee} {unit} phí mạng cho các phê duyệt, cộng phí mạng của hoán đổi, hiển thị sau khi chúng được xác nhận.',
    reviewPayNoFee:
      'Bạn trả {amount} {asset}, cộng phí mạng chưa thể ước tính.',
    reviewReceive:
      'Bạn nhận khoảng {receive} {asset}. Nếu nhận ít hơn {minimum} {asset}, hoán đổi bị hủy và bạn giữ lại tài sản định trả.',
    resultPaidSame:
      'Bạn đã trả {amount} {asset} + {fee} {unit} phí mạng = {total} {unit}.',
    resultPaidOther: 'Bạn đã trả {amount} {asset} + {fee} {unit} phí mạng.',
    resultPaidFeeOnly:
      'Bạn đã trả {fee} {unit} phí mạng và không trả khoản nào khác.',
    warnFeeLarger: 'Phí mạng lớn hơn số tiền bạn đang hoán đổi.',
    warnFeeShare: 'Phí mạng khoảng {percent}% số tiền bạn đang hoán đổi.',
    networkFeeLater: 'ước tính sau khi phê duyệt',
    approval: 'Phê duyệt',
    approvalNeeded:
      'Cần {count} giao dịch phê duyệt trước, đúng bằng số tiền {asset} này',
    slippage: 'Dung sai trượt giá',
    slippageCustom: 'Trượt giá tùy chỉnh, theo phần trăm',
    enterAmount: 'Nhập số tiền',
    review: 'Kiểm tra hoán đổi',
    reviewTitle: 'Xác nhận hoán đổi này',
    reviewNote:
      'Giá được kiểm tra lại khi xác nhận. Hoán đổi hết hạn {seconds} giây sau khi ký.',
    back: 'Quay lại',
    confirm: 'Xác nhận hoán đổi',
    newSwap: 'Hoán đổi mới',
    progressConsolidating: 'Đang chuyển tiền vào tài khoản hoán đổi…',
    progressApproving: 'Đang phê duyệt đúng số tiền ({step} trên {of})…',
    progressSigning: 'Đang chuẩn bị và gửi hoán đổi…',
    progressSubmitted: 'Đã gửi. Đang chờ mạng xác nhận…',
    progressKeepOpen:
      'Bạn có thể rời trang: hoán đổi đã được ghi nhận và xuất hiện trong Hoán đổi gần đây.',
    resultConfirmed: 'Hoán đổi hoàn tất',
    resultConfirmedDetail: 'Đã nhận trong ví, theo ghi nhận trên chuỗi.',
    resultConfirmedUnknown:
      'Hoán đổi đã được xác nhận. Không đọc được số tiền nhận từ biên nhận; số dư bên dưới đã cập nhật.',
    resultReverted: 'Hoán đổi chưa hoàn tất',
    resultRevertedSlippage:
      'Giá biến động vượt dung sai trượt giá nên hoán đổi bị hủy. Bạn giữ lại tiền và chỉ trả phí mạng.',
    resultRevertedDeadline:
      'Hoán đổi đến mạng sau khi hết hạn nên bị hủy. Bạn giữ lại tiền và chỉ trả phí mạng.',
    resultRevertedOther:
      'Mạng từ chối hoán đổi. Bạn giữ lại tiền và chỉ trả phí mạng.',
    resultPending: 'Đã gửi, chưa xác nhận',
    resultPendingDetail:
      'Mạng chưa xác nhận hoán đổi này. Hoán đổi vẫn có thể hoàn tất; trạng thái cập nhật trong Hoán đổi gần đây. Đừng gửi lại.',
    unavailableNetwork: 'Không có hoán đổi cho ví này trên mạng này.',
    unavailableSolana: 'Chưa có hoán đổi cho ví Solana này.',
    unavailableWallet: 'Ví này chưa thể hoán đổi. Mở ví và thử lại.',
    unavailableError: 'Không thể tải hoán đổi. Kiểm tra kết nối.',
    errorSameAsset: 'Chọn hai token khác nhau.',
    errorInsufficientBalance: 'Không đủ {asset}',
    errorInsufficientForFee: 'Không đủ {asset} cho số tiền này cộng phí mạng',
    errorInsufficientNative:
      'Không đủ đồng tiền của mạng để trả hoán đổi này và phí.',
    errorNoRoute: 'Không thể hoán đổi hai token này tại đây.',
    errorNoLiquidity:
      'Pool không thể đáp ứng số tiền này. Hãy thử số tiền nhỏ hơn.',
    errorPriceMoved:
      'Giá biến động vượt dung sai trượt giá. Kiểm tra số tiền mới.',
    errorExpired: 'Hoán đổi hết hạn trước khi gửi. Hãy kiểm tra lại.',
    errorAllowance:
      'Thiếu hoặc hết hiệu lực phê duyệt cho số tiền này. Hãy thử lại.',
    errorAccountBusy:
      'Giao dịch trước của ví này chưa được xác nhận. Thử lại sau giây lát.',
    errorApprovalFailed:
      'Phê duyệt chưa được xác nhận nên chưa hoán đổi gì. Hãy thử lại.',
    errorAccountChanged: 'Tài khoản đã thay đổi. Kiểm tra lại hoán đổi.',
    errorQuote: 'Không thể lấy giá từ mạng. Hãy thử lại.',
    failureDiagnostic: 'Chi tiết lỗi: {stage} · {code}',
    errorExecution:
      'Không thể xác nhận trạng thái hoán đổi. Kiểm tra Hoán đổi gần đây trước khi thử lại; hoán đổi đã gửi vẫn có thể hoàn tất.',
    warnHighImpact:
      'Số tiền này lớn so với pool: bạn nhận ít hơn đáng kể so với tỷ giá thị trường.',
    status: {
      confirmed: 'Đã xác nhận',
      pending: 'Đang chờ',
      failed: 'Chưa hoàn tất',
    },
  },
  solanaSwap: {
    route: 'Lộ trình',
    enterAmount: 'Nhập số tiền cần hoán đổi',
    loading: 'Đang tải token Solana của bạn…',
    unsupportedTitle: 'Không có hoán đổi trên mạng này',
    unsupportedBody:
      'Chưa bật sàn giao dịch cho mạng Solana này nên không thể báo giá hoặc hoán đổi tại đây.',
    loadError: 'Không thể tải token Solana của bạn.',
    pendingUnreadable:
      'Không đọc được bản ghi đã lưu của hoán đổi đang tiến hành trên thiết bị này nên chưa biết có hoán đổi nào còn đang chờ hay không. Không thể bắt đầu hoán đổi mới tại đây cho đến khi giải quyết xong.',
    retry: 'Thử lại',
    venueTestnet:
      'Giao dịch trên {venue}, {network}: token thử nghiệm không có giá trị thực.',
    venueMainnet:
      'Giao dịch trên {venue}, {network}. Hoán đổi này dùng tiền thật.',
    payToken: 'Token bạn trả',
    receiveToken: 'Token bạn nhận',
    flip: 'Đổi chỗ hai token',
    slippage: 'Dung sai trượt giá',
    invalidAmount: 'Nhập số tiền có tối đa {decimals} chữ số thập phân',
    rate: 'Tỷ giá',
    priceImpact: 'Tác động giá',
    minimumReceived: 'Ít nhất nhận được',
    tradeFee: 'Phí pool (đã tính trong tỷ giá)',
    networkFee: 'Phí mạng',
    priorityFee: 'Phí ưu tiên',
    priorityFeeHint:
      'Giao dịch đặt phí này để được đưa vào khối sớm hơn; thu đủ phí nếu hoán đổi được đưa vào khối',
    accountRent: 'Tiền đặt cọc mở tài khoản {token}',
    accountRentHint:
      'Trả một lần. Tiền vẫn ở trong tài khoản của bạn và được trả lại nếu bạn đóng tài khoản.',
    temporaryRent: 'Giữ lại trong khi hoán đổi',
    temporaryRentHint:
      'Ví cần có khoản này khi hoán đổi diễn ra; cùng giao dịch sẽ trả lại khoản đó.',
    platformFee: 'Phí Frank ({percent}%)',
    platformFeeFromInput: 'Là một phần số tiền bạn trả.',
    platformFeeFromOutput: 'Đã trừ khỏi số tiền bạn nhận.',
    totalLeaving: 'Tổng tiền rời ví',
    noPlatformFee: 'Frank không thêm phí cho hoán đổi này.',
    reviewSwap: 'Kiểm tra hoán đổi',
    reviewTitle: 'Kiểm tra hoán đổi này',
    reviewWhereTestnet:
      'Trên {venue}, mạng {network}. Đây là token thử nghiệm không có giá trị thực.',
    reviewWhereMainnet:
      'Trên {venue}, mạng {network}. Giao dịch dùng tiền thật.',
    netLine:
      'Tổng cộng: {give} rời ví và nhận khoảng {get} (không bao giờ dưới {minimum}, nếu thấp hơn thì hoán đổi không diễn ra).',
    costWarning:
      'Phí và tiền đặt cọc ({costs}) bằng {percent}% của {amount} đang hoán đổi.',
    back: 'Quay lại',
    confirmSwap: 'Xác nhận hoán đổi',
    refreshQuote: 'Lấy báo giá hiện tại',
    paid: 'Bạn trả',
    expected: 'Bạn nhận khoảng',
    actuallyPaid: 'Bạn đã trả',
    networkFeeCharged: 'Phí mạng đã thu',
    priorityFeeCharged: 'Phí ưu tiên đã thu',
    totalLeft: 'Tổng tiền đã rời ví',
    received: 'Bạn đã nhận',
    checkAgain: 'Kiểm tra lại',
    newSwap: 'Hoán đổi mới',
    stage: {
      signing: 'Đang ký…',
      submitted: 'Đã gửi. Đang chờ mạng xác nhận…',
      confirmed: 'Hoán đổi hoàn tất',
      failed: 'Hoán đổi thất bại',
      expired: 'Hoán đổi chưa được xử lý',
      unknown: 'Vẫn đang kiểm tra hoán đổi này',
    },
    stageNote: {
      signing: 'Ví đang ký hoán đổi. Chưa gửi gì.',
      submitted:
        'Thường mất vài giây. Bạn có thể rời trang; hoán đổi đã được ghi nhận và tiếp tục được theo dõi.',
      confirmed:
        'Các số liệu này lấy từ giao dịch đã xác nhận, không phải báo giá.',
      failed: 'Mạng từ chối hoán đổi nên chưa trao đổi gì. Chỉ trả phí mạng.',
      expired:
        'Mạng không đưa hoán đổi vào khối trước khi hết hạn. Chưa trao đổi gì và chưa trả phí. Bạn có thể thử lại.',
      unknown:
        'Không thể kết nối mạng nên chưa biết hoán đổi này đã thành công hay chưa. Chưa gửi lại dưới dạng hoán đổi mới.',
    },
    error: {
      invalidRequest:
        'Không thể báo giá hoán đổi này. Có thể số tiền quá nhỏ hoặc hai token giống nhau.',
      noRoute: 'Không có thị trường cho cặp này tại đây.',
      insufficientBalance: 'Bạn không đủ token dùng để trả.',
      insufficientSol:
        'Không đủ SOL cho hoán đổi này, phí mạng và các khoản đặt cọc.',
      slippage:
        'Giá biến động vượt dung sai trượt giá. Lấy báo giá mới hoặc tăng dung sai.',
      simulationFailed: 'Mạng sẽ từ chối hoán đổi này nên chưa gửi.',
      venueUnavailable: 'Sàn giao dịch không trả lời. Thử lại sau vài giây.',
      unsafeTransaction:
        'Giao dịch cho hoán đổi này sẽ thực hiện việc khác ngoài hoán đổi đã báo giá nên chưa ký.',
      unexpected: 'Đã xảy ra lỗi và hoán đổi chưa được gửi.',
    },
  },
  calendarInvite: {
    allDay: 'Cả ngày',
    organizer: 'Người tổ chức',
    location: 'Địa điểm',
    statusConfirmed: 'Đã xác nhận',
    statusTentative: 'Tạm thời',
    statusCancelled: 'Đã hủy',
    rsvpTally:
      '{accepted} Chấp nhận · {tentative} Tạm thời · {declined} Từ chối',
    accept: 'Chấp nhận',
    tentative: 'Tạm thời',
    decline: 'Từ chối',
    addToOsCalendar: 'Thêm vào Lịch Apple / Hệ điều hành (.ics)',
    addToGoogleCalendar: 'Google Calendar',
    attachCalendarOrContact: 'Đính kèm lịch (.ics) hoặc liên hệ (.vcf)',
    invalidFile: 'Không thể đọc {name}: {reason}',
  },
  contactCard: {
    title: 'Thẻ liên hệ',
    frankAddress: 'Địa chỉ Frank',
    email: 'Email',
    phone: 'Điện thoại',
    website: 'Trang web',
    addToContacts: 'Thêm vào danh bạ Frank',
    addedToContacts: 'Đã thêm vào danh bạ Frank',
    saveVcf: 'Lưu vCard (.vcf)',
  },
  onboard: {
    toolbarTitle: 'Bắt đầu với Frank',
    headerBadge: 'Thiết lập tài khoản tự lưu ký, mã hóa đầu cuối',
    heading: 'Tiếp tục cuộc trò chuyện trên Frank',
    keysGeneratedPrefix: 'Khóa riêng của bạn được tạo',
    keysGeneratedHighlight: '100% cục bộ trong trình duyệt',
    keysGeneratedSuffix: 'và không bao giờ được chia sẻ với cổng email.',
    threadImportPrefix: 'Luồng email của bạn với',
    threadImportSuffix: 'sẽ được nhập tự động.',
    subjectLabel: 'Chủ đề:',
    bridgedEmailLabel: 'Email được chuyển qua cầu nối:',
    signedInAs: 'Đã đăng nhập với',
    localFrankAccount: 'Tài khoản Frank cục bộ',
    importThreadAndOpenChat: 'Nhập luồng & Mở trò chuyện với đối tác',
    displayNameLabel: 'Tên hiển thị',
    displayNameHint: 'Hiển thị cho liên hệ khi bạn nhắn tin trên Frank',
    createAccountAndOpenChat: 'Tạo tài khoản tự lưu ký & Mở trò chuyện',
    continueWithPasskey: 'Tiếp tục với khóa truy cập (Mera)',
  },
  close: 'Đóng',
  signedSwap: {
    actions: {
      offer: 'Đề nghị',
      accept: 'Chấp nhận',
      reject: 'Từ chối',
    },
    title: 'Hoán đổi',
    negotiationOnly:
      'Chỉ thương lượng có chữ ký. Chấp nhận không chuyển tiền hoặc cấp quyền sử dụng tiền.',
    offerAmount: 'Đề nghị {unit} trên {network}',
    requestAmount: 'Yêu cầu {unit} trên {network}',
    expiry: 'Hết hạn ({timezone})',
    review: 'Kiểm tra',
    propose: 'Ký và đề xuất',
    newOffer: 'Đề nghị mới',
    accept: 'Chấp nhận',
    reject: 'Từ chối',
    confirmResponse: 'Ký {decision}',
    stamp: 'Tem tin nhắn',
    baseUnits: 'đơn vị cơ sở',
    history: 'Lịch sử thương lượng đã xác thực',
    pending: 'Ủy quyền đã lưu',
    resume: 'Tiếp tục ủy quyền ban đầu',
    selectExpiry: 'Chọn ngày giờ hết hạn.',
    delivery: 'Chuyển phát tin nhắn',
    error: 'Không thể hoàn tất thương lượng',
    legacy: 'Lịch sử hoán đổi không có chữ ký không được hỗ trợ',
    phases: {
      claimed: 'Chưa hoàn tất chữ ký',
      signed: 'Đã lưu chữ ký',
    },
    deliveryStates: {
      'confirmed': 'Đã chuyển phát',
      'pending': 'Đang chờ chuyển phát',
      'payment-pending': 'Đang chờ thanh toán tem',
      'error': 'Chưa hoàn tất chuyển phát',
    },
    errors: {
      capacity:
        'Đã đạt giới hạn lưu trữ. Các ủy quyền đã lưu vẫn được giữ lại.',
      expired:
        'Chọn thời điểm hết hạn trong tương lai cho ủy quyền mới. Tin nhắn đã ký giữ nguyên thời điểm hết hạn ban đầu.',
      conflict: 'Vị trí ký này đã gắn với ủy quyền khác.',
      invalidAmount:
        'Nhập số thập phân dương chính xác trong giới hạn độ chính xác của đồng tiền gốc và giới hạn giao thức.',
      invalidIntent: 'Ủy quyền đã lưu không hợp lệ. Vẫn giữ lại để kiểm tra.',
      sessionChanged:
        'Tài khoản, mạng hoặc cuộc trò chuyện đã xác thực đã thay đổi. Kiểm tra lại.',
      storage: 'Không dùng được bộ nhớ. Ủy quyền chưa bị loại bỏ.',
      deliveryPending:
        'Đã lưu chữ ký nhưng chưa chuyển phát xong tin nhắn ban đầu. Hãy tiếp tục.',
      failed:
        'Không thể hoàn tất thương lượng. Ủy quyền đã lưu vẫn được giữ lại.',
    },
    states: {
      'restoring': 'Đang khôi phục bằng chứng thương lượng',
      'scanning': 'Đang kiểm tra tin nhắn đã xác thực',
      'ready': 'Sẵn sàng',
      'unsupported': 'Không có thương lượng hoán đổi trên mạng này',
      'incomplete': 'Bằng chứng đã xác thực chưa đầy đủ',
      'capacity': 'Đã đạt giới hạn lưu trữ thương lượng',
      'storage-error': 'Lưu trữ thương lượng thất bại',
      'awaitingAdmission': 'Sự kiện đã ký đang chờ được tiếp nhận có xác thực',
      'conflict': 'Bằng chứng thương lượng xung đột',
      'expired': 'Thương lượng đã hết hạn',
      'offered': 'Đề nghị đã xác thực',
      'accept': 'Chấp nhận đã xác thực; chưa chuyển tiền',
      'reject': 'Từ chối đã xác thực',
    },
  },
}
