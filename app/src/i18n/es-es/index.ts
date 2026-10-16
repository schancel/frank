// Neutral Spanish catalog. Keep keys and interpolation tokens aligned with en-us.
export default {
  negotiationRecovery: {
    'restoring': 'Restaurando el historial de intercambios',
    'scanning': 'Comprobando el historial de intercambios',
    'ready': 'Historial de intercambios recuperado',
    'unsupported':
      'La recuperación de intercambios no está disponible en esta red',
    'incomplete':
      'La comprobación del historial de intercambios está incompleta',
    'capacity': 'El almacenamiento del historial de intercambios está lleno',
    'storage-error': 'No se pudo restaurar el historial de intercambios',
  },
  qrScanner: {
    paymentHint:
      'Para realizar pagos, escanea el código QR de Recibir de la cartera. El QR de un perfil identifica a un contacto de mensajería y no es una dirección de depósito de la cartera.',
    open: 'Escanear código QR',
    title: 'Escanear una dirección',
    network: 'Red: {network}',
    addressOnly:
      'Escanea una dirección sin formato de esta red. Revísala antes de confirmar. No se admiten enlaces de pago.',
    starting: 'Iniciando la cámara…',
    scanning: 'Apunta la cámara al código QR.',
    invalid: 'Este código QR no contiene una dirección admitida en esta red.',
    denied:
      'Se denegó el acceso a la cámara. Permite el acceso o introduce la dirección manualmente.',
    unavailable:
      'Cámara no disponible. Usa HTTPS y un navegador compatible, o introduce la dirección manualmente.',
    retry: 'Volver a intentar',
    manual: 'Introducir manualmente',
  },
  notificationPermission: {
    title: 'Notificaciones',
    default: 'Las notificaciones del navegador no están activadas.',
    granted: 'Las notificaciones del navegador están activadas.',
    denied:
      'Las notificaciones del navegador están bloqueadas. Permítelas en la configuración del sitio de tu navegador y vuelve a Frank.',
    unsupported: 'Este navegador no admite notificaciones de escritorio.',
    enable: 'Activar notificaciones',
    notNow: 'Ahora no',
    offer: 'Recibe notificaciones cuando lleguen mensajes',
    offerHint:
      'Activa las notificaciones del navegador ahora o más adelante en Configuración → Notificaciones.',
    contactHint:
      'La preferencia de notificaciones de cada contacto es independiente de este permiso del navegador.',
    failed:
      'No se pudieron activar las notificaciones. Revisa la configuración del sitio en tu navegador.',
  },
  startupFailure: {
    title: 'No se pudieron cargar los datos guardados',
    message:
      'El inicio se ha detenido. Tus datos guardados no se han restablecido.',
    loading: 'Cargando los datos guardados',
  },
  tempoPayment: {
    interrupted:
      'Un pago de Tempo necesita revisión. Vuelve a la cuenta que lo inició y consulta la actividad de pagos. Si se te indica, reanuda allí el mismo pago; no crees otro pago para lo mismo.',
    dismiss: 'Cerrar aviso',
  },
  accountRecovery: {
    mera_title: 'Mera',
    mera_choose:
      'Usa una clave de acceso existente o crea una cuenta nueva con una clave de acceso nueva.',
    mera_existing: 'Usar clave de acceso existente',
    mera_new: 'Crear clave de acceso',
    mera_create: 'Crear con Mera',
    mera_login: 'Continuar con Mera (clave de acceso)',
    mera_verification_unreachable:
      'No se pudo verificar tu cuenta existente. Tu cuenta con clave de acceso está lista para confirmar; comprueba tu conexión antes de continuar.',
    mera_description:
      'Una clave de acceso nueva crea una cuenta nueva de Frank. Inicia sesión con tu clave de acceso existente para volver a la misma cuenta en este sitio web. También puedes guardar fragmentos de recuperación desde la copia de seguridad de la cuenta.',
    mera_unsupported:
      'Las claves de acceso requieren un sitio web seguro y un navegador compatible. Usa la creación de cuentas o los fragmentos de recuperación.',
    mera_cancelled:
      'La solicitud de clave de acceso se canceló o agotó el tiempo de espera. No se activó ninguna cuenta. Vuelve a intentarlo cuando estés listo.',
    mera_prf:
      'Esta clave de acceso o navegador no proporcionó el secreto PRF requerido. No se activó ninguna cuenta. Prueba con un proveedor de claves de acceso y un navegador compatibles, o usa fragmentos de recuperación.',
    mera_failed:
      'No se pudo completar la solicitud de clave de acceso. No se activó ninguna cuenta. Reintenta con la misma clave de acceso. Es posible que se haya creado una clave antes del fallo; usa el inicio de sesión con una clave existente para reintentarlo.',
    wallet_chain_mismatch:
      'Esta cartera guardada no coincide con la configuración de red o cuenta que usa la aplicación. Restaura la configuración de red anterior e intenta abrir de nuevo la cuenta existente. Sus datos guardados no han cambiado.',
    profile_restore_unreachable:
      'Se recuperó tu cuenta, pero no se pudo obtener su perfil. Comprueba la conexión con el servidor de retransmisión y vuelve a intentarlo.',
    profile_restore_retry: 'Reintentar la búsqueda del perfil',
    pending_outdated_cancel_and_redo:
      'Una versión anterior de Frank guardó este intento y no se puede activar. Cancélalo y vuelve a crear o restaurar la cuenta. Los fragmentos que anotaste siguen permitiendo restaurarla.',
    pending_retry:
      'No se pudo completar la limpieza de la cuenta pendiente. Tu cuenta activa no ha cambiado. Reintenta o cancela este intento antes de iniciar otro.',
    balance_loading: 'Cargando el saldo…',
    balance_unavailable: 'Saldo no disponible. Reintentando.',
    balance_stale:
      'Último saldo conocido — no se pudo actualizar. Este valor puede estar desactualizado.',
    profile_unavailable:
      'La publicación del perfil público y la mensajería directa aún no están disponibles para esta cuenta. No se publicará ninguna identidad del directorio anterior. El nombre local de tu cuenta no ha cambiado.',
    open_navigation: 'Abrir navegación',
    frank_account: 'Cuenta de Frank',
    saved_account_data_could_not_be_opened:
      'No se pudieron abrir los datos guardados de la cuenta. No se han reemplazado. Esta versión preliminar requiere almacenamiento cifrado del navegador; no se admiten aplicaciones nativas.',
    retry_opening_account: 'Reintentar',
    reset_account_storage: 'Restablecer almacenamiento',
    reset_account_storage_confirm:
      'Al restablecer el almacenamiento dañado se borrarán los datos locales de la cuenta que no se pueden abrir. Después podrás restaurar tu cuenta con los fragmentos de la copia de seguridad. ¿Continuar?',
    a_saved_account_attempt_is_pending_it:
      'Hay un intento de cuenta guardado pendiente. No estará activo hasta que elijas Activar cuenta.',
    account_found: 'Confirmar identidad',
    activate_account: 'Activar',
    pending_identity_address:
      'La activación abre la cuenta con esta dirección de identidad. Su perfil publicado se cargará por separado:',
    pending_username: 'Nombre de usuario',
    pending_profile_loading: 'Comprobando el perfil publicado…',
    pending_profile_unreachable:
      'No se pudo comprobar el perfil publicado. Verifica la conexión con el servidor de retransmisión y reintenta. Aun así puedes confirmar la dirección de identidad.',
    pending_profile_unverified:
      'No se pudo verificar el perfil recibido para esta identidad. Comprueba la dirección de identidad antes de activar.',
    pending_identity_stop_if_unexpected:
      'Si estás restaurando una cuenta y esta no es la dirección que esperabas, detente: no la actives. Cancela el intento.',
    the_attempt_is_incomplete_or_awaiting_cleanup:
      'El intento está incompleto o pendiente de limpieza. Cancélalo explícitamente antes de iniciar otra cuenta.',
    cancel_pending_attempt: 'Cancelar',
    create_a_frank_account_backup_or_restore:
      'Crea una cuenta de Frank y su copia de seguridad, o restaura una con tus fragmentos de recuperación guardados. No se necesitan fondos para activarla localmente.',
    an_existing_legacy_account_is_quarantined_its:
      'Una cuenta anterior existente está en cuarentena. Sus datos guardados permanecen intactos y no se abre como la cuenta normal.',
    changing_accounts_replaces_the_active_local_account:
      'Cambiar de cuenta reemplaza la cuenta local activa tras confirmar la copia de seguridad. Conserva tu copia de seguridad existente.',
    i_understand_this_changes_the_active_local:
      'Entiendo que esto cambia la identidad local activa y no transfiere fondos ni historial.',
    new_account: 'Nueva cuenta',
    restore_account: 'Restaurar cuenta',
    legacy_recovery_migration: 'Recuperación de cuenta anterior',
    return_to_wallet: 'Volver',
    this_identifies_your_old_account_locally_you:
      'Introduce la frase BIP39 guardada de tu cuenta de Frank. Revisa su dirección de identidad antes de activarla. Tu perfil existente se obtendrá después de la recuperación.',
    legacy_bip39_recovery_phrase: 'Frase de recuperación BIP39 anterior',
    identify_legacy_account_locally: 'Restaurar cuenta BIP39',
    old_account: 'Cuenta anterior:',
    the_new_identity_is_different_no_funds:
      '. La nueva identidad es diferente; no se migran fondos, historial ni claves remotas.',
    choose_how_many_shares_you_must_retain:
      'Elige cuántos fragmentos debes conservar. Si pierdes demasiados, perderás el acceso permanentemente. Guarda los fragmentos en lugares seguros separados; cualquiera que reúna el umbral puede recuperar la cuenta.',
    generate_frank_account_backups: 'Generar copias de seguridad',
    frank_account_backup: 'Copia de seguridad de la cuenta de Frank',
    save_each_share_before_moving_on_exactly:
      '. Guarda cada fragmento antes de continuar. Se necesitan exactamente',
    consistent_shares_are_required_to_confirm:
      'fragmentos coherentes para confirmar.',
    frank_account_backup_share:
      'Fragmento de la copia de seguridad de la cuenta de Frank',
    copy_this_share: 'Copiar este fragmento',
    save_two_independent_copies_of_this_public:
      'Guarda dos copias independientes de este descriptor público de cuenta junto con tus registros de recuperación. Permite identificar una cuenta recuperada, pero no demuestra por sí mismo su propiedad. Usa tu copia guardada de forma independiente al restaurar.',
    public_frankdesc_descriptor: 'Descriptor público frankdesc',
    copy_public_descriptor: 'Copiar descriptor público',
    i_saved_two_independent_copies_of_the:
      'He guardado dos copias independientes del descriptor público.',
    confirm_my_saved_backups: 'Confirmar copias de seguridad',
    enter_the_public_frankdesc_descriptor_from_an:
      'Introduce primero el descriptor público frankdesc de una copia guardada de forma independiente. Son metadatos para identificar la cuenta, no una prueba que se autentique por sí misma. Nunca uses un descriptor deducido de los fragmentos introducidos.',
    independently_saved_frankdesc_descriptor:
      'Descriptor frankdesc guardado de forma independiente',
    pin_expected_account: 'Fijar cuenta esperada',
    re_enter_exactly: 'Vuelve a introducir exactamente',
    saved_frank_account_backup_shares_we_reconstruct:
      'fragmentos guardados de la copia de seguridad de la cuenta de Frank. Reconstruimos y comparamos la cuenta completa antes de prepararla.',
    enter_at_least_the_threshold_number_of_shares:
      'Introduce al menos el número de fragmentos indicado como umbral en tu copia de seguridad, uno por línea. Los fragmentos adicionales de la misma copia permiten detectar uno incorrecto e indicar cuál es.',
    share_report_title:
      'Lo que encontró la aplicación en los fragmentos introducidos:',
    share_report_supports: 'Fragmento {n} (índice {index}): utilizado.',
    share_report_inconsistent:
      'Fragmento {n} (índice {index}): no pertenece a esta copia de seguridad. Es incorrecto o está dañado.',
    share_report_different_set:
      'Fragmento {n} (conjunto {identifier}): pertenece a otro conjunto de copia de seguridad.',
    share_report_duplicate: 'Fragmento {n}: introducido más de una vez.',
    share_report_invalid:
      'Fragmento {n}: no se pudo leer. Comprueba si contiene un error de escritura.',
    restore_choose_explained:
      'Estos fragmentos contienen copias completas de más de una cuenta. Frank no elegirá por ti. Si no lo esperabas, alguien podría haberte dado fragmentos de una cuenta que controla. Restaura solo la dirección que reconozcas.',
    restore_choose_identity: 'Cuenta con esta dirección de identidad:',
    restore_choose_shares: 'Reconstruida con los fragmentos {shares}.',
    restore_choose_pick: 'Restaurar esta cuenta',
    expected_account: 'Cuenta esperada:',
    insufficient_share_set:
      'Copia de seguridad {identifier}: {available} fragmentos distintos disponibles; se requieren {required}.',
    saved_codex32_shares_one_per_line:
      'Fragmentos de recuperación guardados, uno por línea',
    display_name: 'Nombre visible',
    display_name_required:
      'Obligatorio. Es el nombre que verán las personas a las que escribas; puedes cambiarlo después en tu perfil.',
    verify_backups_and_stage_account:
      'Verificar copias de seguridad y preparar la cuenta',
    cancel_and_start_again: 'Cancelar',
    browser_preview_encrypted_local_storage_does_not:
      'Versión preliminar para navegador: el almacenamiento local cifrado no protege frente a código malicioso en este origen ni al robo de todo el perfil del navegador. Conserva copias independientes. Borrar los datos locales puede eliminar el acceso.',
    messaging_is_unavailable_for_typed_accounts_in:
      'La mensajería no está disponible para cuentas tipadas en esta versión preliminar.',
    main_wallet: 'Cartera principal',
    frank_account_recovery: 'Recuperación de cuenta de Frank',
    backup_shares_were_verified_before_activation_keep:
      'Los fragmentos se verificaron antes de la activación. Mantén seguras tus copias guardadas. Las raíces de dominio residentes no pueden recrear el secreto maestro original ni los fragmentos de la copia de seguridad.',
    public_recovery_descriptor: 'Descriptor público de recuperación',
    fingerprint: 'Huella:',
    create_or_restore_account: 'Crear o restaurar cuenta',
    frank_account_backups_were_verified_before_activation:
      'Las copias de seguridad de la cuenta de Frank se verificaron antes de la activación. Conserva los fragmentos guardados y el descriptor público; este dispositivo no puede recrear los fragmentos originales.',
    browser_storage: 'Almacenamiento del navegador',
    browser_persistence_reduces_automatic_eviction_it_is:
      'La persistencia del navegador reduce la eliminación automática de datos. No es una copia de seguridad ni protege frente a código malicioso o al robo del perfil del navegador.',
    request_persistent_storage: 'Solicitar almacenamiento persistente',
    keep_independent_account_backup:
      'Conserva una copia de seguridad independiente de tu cuenta. La protección del almacenamiento del navegador no es una copia de seguridad.',
    import_bip39_seed: 'Importar semilla BIP39',
    not_backed_up_tooltip:
      'Aún no has hecho una copia de seguridad de tu cartera o identidad. Pulsa para hacerla ahora.',
    backup_account_codex32: 'Copia de seguridad de la cuenta',
    codex32_threshold_explainer:
      'Anota cada fragmento. Cualesquiera {threshold} de estos {count} fragmentos restauran el secreto original de la cuenta y su derivación.',
    codex32_backup_sets_do_not_mix:
      'Este es un conjunto nuevo. No se pueden combinar fragmentos de conjuntos distintos, incluidos los que se mostraron al crear la cuenta. Cambiar el esquema o volver a abrir esta página crea otro conjunto, así que termina de anotar este primero.',
    cancel_scheme: 'Cancelar',
    recovery_shares_privacy:
      'Cualquiera que vea estos fragmentos puede apoderarse de esta cuenta. Asegúrate de que nadie más pueda ver tu pantalla.',
    codex32_backup_unavailable_for_account:
      'El secreto original necesario para emitir fragmentos no está disponible en este dispositivo. Tu copia de seguridad existente sigue siendo válida.',
    historical_share_keep_both_lines:
      'Conserva juntas las líneas Seed y Check como un único fragmento en papel. Introduce ambas líneas juntas al restaurar.',
    backup_seed_line: 'Seed',
    backup_check_line: 'Check',
    configure_scheme: 'Configurar umbral y fragmentos',
    custom_threshold_shares: 'Umbral y fragmentos personalizados',
    threshold: 'Umbral',
    total_shares: 'Total de fragmentos',
    apply: 'Aplicar',
    generating_codex32_backup_shares: 'Generando fragmentos de recuperación…',
    share: 'Fragmento',
    copy_share: 'Copiar',
    verify_shards_title: 'Verificar fragmentos',
    verify_shards_explainer:
      'Prueba los fragmentos guardados introduciendo al menos el número requerido por el umbral para verificar que reconstruyen tu cuenta.',
    verify_shards_button: 'Verificar fragmentos',
    verify_shards_clear: 'Borrar',
    verify_shards_success:
      '¡Fragmentos verificados correctamente! Tu copia de seguridad es válida.',
    advanced_details: 'Detalles avanzados',
    advanced_options: 'Opciones avanzadas',
    relay_server: 'Servidor de retransmisión',
    relay_server_url: 'URL del servidor de retransmisión',
    relay_server_url_hint:
      'Servidor de retransmisión principal de tu buzón cifrado y perfil',
    reset_to_default_relay:
      'Restablecer el servidor de retransmisión predeterminado',
    invalid_relay_url: 'Introduce una URL HTTP o HTTPS válida',
    relay_discovered:
      'Servidor de retransmisión principal existente encontrado: {url}. Configurado automáticamente.',
    frank_is_open_in_another_tab: 'Frank está abierto en otra pestaña',
    multi_tab_notice:
      'Tu cuenta sigue guardada en este dispositivo. Frank está activo en otra pestaña o ventana. Para proteger tu cartera, solo una puede usar la cuenta a la vez. Elige «Usar Frank aquí» para continuar aquí y pausar la otra pestaña.',
    use_frank_here: 'Usar Frank aquí',
    switch_to_open_tab: 'Buscar la pestaña abierta de Frank',
    find_tab_waiting: 'Contactando con tu pestaña abierta de Frank…',
    find_tab_focused:
      'Tu pestaña abierta de Frank respondió. Si no apareció, selecciónala en tu navegador.',
    find_tab_notified:
      'Se envió una notificación desde tu pestaña abierta de Frank. Haz clic en ella para volver allí. Si no aparece, selecciona la pestaña en tu navegador.',
    find_tab_manual:
      'Tu pestaña abierta de Frank respondió, pero el navegador no pudo cambiar a ella automáticamente.',
    find_tab_unavailable:
      'Tu pestaña abierta de Frank no respondió. Es posible que tu navegador la haya suspendido.',
    find_tab_idle:
      'Busca tu pestaña abierta de Frank o elige «Usar Frank aquí».',
    find_tab_notification_title: 'Tu pestaña abierta de Frank',
    find_tab_notification_body:
      'Haz clic en esta notificación para volver a la pestaña de Frank que usa tu cuenta.',
    manual_tab_switch_hint:
      'Selecciona la pestaña de Frank en la barra o vista general de pestañas del navegador. Si no la encuentras, elige «Usar Frank aquí» para trasladar tu cuenta a esta pestaña.',
    tab_yielded_notice: 'Frank está activo en otra pestaña o ventana.',
  },
  agree: 'Aceptar',
  chat: {
    groupRecipientNoticeSelf:
      'Los mensajes que envías aquí son notas para ti. Ninguna otra persona que haya publicado aquí los recibe.',
    groupRecipientNotice:
      'Tus mensajes aquí se envían solo a {name}, no a todos los participantes de esta conversación.',
    sendMessage: 'Enviar mensaje',
    stampPreparationChecking: 'Comprobando cuentas privadas para sellos…',
    stampPreparationFunding:
      'Preparando cuentas privadas para sellos ({completed}/{total} transacciones en cadena; hasta {feeReserve} {unit} de reserva para comisiones en cada una)…',
    stampPreparationReady:
      'Cuentas privadas para sellos listas; enviando mensaje…',
    stampPreparationWaiting: 'Esperando la confirmación del pago anterior…',
    stampPreparationWaitingBlocks:
      'Esperando la confirmación del pago anterior (faltan {blocks} bloques)…',
    sendContextChanged:
      'La cuenta, cadena o conversación ha cambiado. Revisa la acción de nuevo.',
    chainUnreachable:
      'No se puede acceder a la red. Los mensajes de pago están en cola y se enviarán cuando vuelva a estar disponible.',
    donationMessage:
      'Gracias por participar en nuestra visión del futuro de las comunicaciones en línea. Considera apoyar nuestro trabajo enviando BCH reales a bitcoincash:qq7vt04md0pt6fk5szhcx4cgsfuzmppy5u4hxshr4a',
  },
  stampPreparation: {
    refreshStatus: 'Actualizar estado',
    posting: 'Publicando…',
    voting: 'Votando…',
    sendingVote: 'Enviando voto…',
    postCreated: 'Publicación creada en {topic}.',
    replyParentLoading: 'Cargando la publicación a la que respondes…',
    replyParentUnavailable:
      'No se pudo cargar la publicación a la que respondes. Puedes volver a intentarlo.',
    retryReplyParent: 'Volver a intentar',
    postedRefreshFailed:
      'Tu publicación se publicó, pero no se pudo actualizar la vista. Recarga para verla. No la publiques de nuevo.',
    postOutcomeUnknown:
      'Es posible que tu publicación se haya publicado. Recarga para comprobarlo. No la publiques de nuevo.',
    votedRefreshFailed:
      'Tu voto se envió, pero no se pudo actualizar la vista. Recarga para verlo. No vuelvas a votar.',
  },
  forum: {
    postsLabel: 'publicaciones',
    noPosts: 'Aún no hay publicaciones.',
    outageTitle: 'Foro no disponible',
    outageDescription:
      'No se pudo conectar con el servidor de retransmisión del foro. Comprueba tu conexión o vuelve a intentarlo.',
    outageBanner:
      'No se puede acceder al servidor de retransmisión del foro. Se muestran publicaciones guardadas.',
    degradedTitle: 'Conexión degradada',
    degradedBanner: 'No se pudieron actualizar algunos temas del foro.',
    retry: 'Reintentar',
    loginSignUp: 'Iniciar sesión / Registrarse',
    thread: 'Hilo',
    allTopics: 'Todos los temas',
    filteredBy: 'Filtrado por tema',
    clearTopicFilter: 'Quitar filtro',
    percentileFilter: 'Filtro por percentil',
    allPosts: 'Todas las publicaciones',
    editor: {
      toolbar: 'Herramientas de formato',
      bold: 'Negrita',
      italic: 'Cursiva',
      heading: 'Encabezado',
      quote: 'Cita',
      code: 'Código',
      bullet: 'Lista con viñetas',
      link: 'Enlace',
      attachImage: 'Adjuntar imagen',
      imageProcessing: 'Procesando imagen…',
      imageTooLarge:
        'La imagen es demasiado grande para la publicación (debe ocupar menos de 120 KB tras la compresión)',
      imageError: 'No se pudo procesar la imagen adjunta',
      invalidImageType:
        'Selecciona un archivo de imagen válido (PNG, JPEG, WebP, GIF)',
      removeAttachment: 'Quitar adjunto',
    },
  },
  chatLayout: {
    invalidSubject:
      'Usa un asunto de un máximo de 512 bytes UTF-8 y sin caracteres de control.',
    participantCount: '{count} participantes',
    editSubject: 'Editar asunto',
    subject: 'Asunto',
    saveSubject: 'Guardar',
    cancelSubject: 'Cancelar',
    info: 'Información',
    infoTitle: 'Información',
    mute: 'Silenciar',
    unmute: 'Activar sonido',
    selectMessages: 'Eliminar mensajes',
    selectMessagesTitle: 'Eliminar mensajes',
  },
  chatInput: {
    giveLotusSecretly: 'Dar Lotus en privado',
    sendStealth: 'Enviar pago privado',
    offerSwap: 'Ofrecer intercambio atómico',
    attachImage: 'Adjuntar imagen',
    removeAttachment: 'Quitar {name}',
    imageRefused: 'No se puede enviar {name}: {reason}.',
    messageTooLarge:
      'Este mensaje es demasiado grande para enviarlo. Quita una imagen o acorta el texto.',
    blackjackChallenge: 'Desafío de blackjack',
    placeHolder: 'Escribe un mensaje...',
    emojiPickerTitle: 'Seleccionar un emoji',
    stampPrice: 'Precio del sello',
    stampPayment: 'Pago del sello',
    stampQuickSelection:
      'Selección rápida: gratis, fracciones o múltiplos del valor predeterminado',
    stampMultiplierValue: '{multiplier}× el valor predeterminado ({amount})',
    defaultStamp: 'Predeterminado: {amount}',
    stampBelowMinimum:
      'Este importe es inferior al mínimo actual de {amount} {unit}. Elige otro importe o un mensaje gratis.',
    stampQuoteUnavailable: 'Sello predeterminado no disponible',
    fixedStampFallback:
      'Valor predeterminado temporal: {amount} {unit}, basado en un importe base fijo y el mínimo actual de comisión. La tasa AVU no está disponible.',
    stampQuoteUnavailableReason:
      'Sello predeterminado no disponible: {reason}. Elige un importe explícito o un mensaje gratis.',
    stampQuoteReasons: {
      'messaging-pending': 'la cuenta aún se está conectando',
      'missing-rate': 'falta la tasa de conversión',
      'stale-rate': 'la tasa de conversión está desactualizada',
      'missing-fee': 'estimación de comisión no disponible',
      'unsupported': 'mensajería no compatible',
    },
    resetToDefault: 'Restablecer valor predeterminado',
    stampReset: 'Predeterminado',
    stampFree: 'Gratis',
    stampChipFree: 'Sin sello: este mensaje es gratis',
    stampChip: 'Sello: {amount}',
    stampChipMultiple: 'Sello: {amount}, {multiplier}× el valor predeterminado',
    stampWhat:
      'Un sello es un pequeño pago que se envía con tu mensaje a la persona a la que escribes. Remunera su atención.',
    stampWhy:
      'Cada mensaje lleva el sello predeterminado, salvo que elijas otro importe para este chat. Introduce 0 para enviar mensajes gratis.',
  },
  digitalGoods: {
    catalog: 'Catálogo',
    buy: 'Comprar',
    confirmPrompt: '¿Pagar {price} a {name} ({address}) por "{item}"?',
    confirmBuy: 'Confirmar y pagar {price}',
    cancel: 'Cancelar',
    confirmGroupLabel: 'Confirmar compra de {item}',
    priceUnavailable: 'precio no disponible',
    hiddenOne: '{count} artículo más sin mostrar',
    hiddenMany: '{count} artículos más sin mostrar',
    requested: 'Solicitado: {itemId}',
    fulfilled: 'Aquí está tu compra ({itemId}):',
  },
  chatImage: {
    onePhoto: '📷 Foto',
    manyPhotos: '📷 {count} fotos',
    notShown: 'Imagen no mostrada ({reason})',
    reasonNotAnImage: 'no es una imagen',
    reasonTooLarge: 'demasiado grande',
    reasonNotInline: 'no es una imagen integrada',
    reasonUnreadableHeader: 'cabecera de imagen ilegible',
    reasonEmpty: 'imagen vacía',
    reasonDimensionsTooLarge: 'dimensiones demasiado grandes',
  },
  raffle: {
    enter: 'Participar',
    confirmGroupLabel: 'Confirmar participación en el sorteo',
    confirmPrompt: '¿Pagar {amount} para participar?',
    confirm: 'Confirmar',
    cancel: 'Cancelar',
    insufficient: 'Eso supera lo que puedes gastar ahora ({balance}).',
    balanceUnknown: 'Aún no se conoce tu saldo.',
    leave: 'Abandonar',
    leaveAriaLabel: 'Abandonar la ronda {raffleId} del sorteo',
    leftAction: 'Abandonaste el sorteo',
    leftStatus:
      'Abandonaste el sorteo: {count}/{max} participantes. Tu participación se ha reembolsado.',
  },
  gameFairness: {
    diceRejected: 'No se realizó ninguna tirada.',
    diceRejectionReasons: {
      'roll-not-offered': 'No se ofreció esta tirada.',
      'commitment-mismatch':
        'El compromiso no coincide con la tirada ofrecida.',
      'invalid-client-seed': 'El valor aleatorio del jugador no es válido.',
      'invalid-target': 'El objetivo de la tirada no es válido.',
      'invalid-wager': 'La apuesta no es válida.',
      'below-minimum': 'La apuesta está por debajo del mínimo.',
      'payout-limit': 'El premio posible supera el límite de la mesa.',
      'payment-not-confirmed': 'No se confirmó el pago de la apuesta.',
    },
    dicePractice: 'Práctica',
    dicePracticeDescription:
      'Sin apuesta ni premio. La práctica usa las mismas reglas de tirada sin apostar fondos.',
    dicePracticeRoll: 'Tirada de práctica',
    diceRoll: 'Tirar',
    moveNotSent:
      'No enviado. Usa Reintentar en tu mensaje de abajo o descártalo para volver a elegir.',
    notVerified: 'NO VERIFICADO.',
    diceVerified:
      'Verificado: el secreto coincide con el compromiso sobre el que apostaste, y el número, resultado y premio se derivan de él y de tu propio valor aleatorio.',
    diceHow: 'Cómo se comprobó',
    diceCommitment: 'Compromiso (antes de tu apuesta): {value}',
    diceSecret: 'Secreto (revelado): {value}',
    diceSeed: 'Tu valor aleatorio: {value}',
    diceRule:
      'SHA-256(secreto) debe coincidir con el compromiso; la tirada corresponde a los primeros 16 bits de HMAC-SHA256(secreto, tu valor).',
    rpsVerified:
      'Verificado: la jugada y la sal que reveló el bot coinciden con el compromiso que envió antes de tu jugada.',
    payoutClaimed:
      'Premio: {amount}. El bot afirma que este mensaje lo incluye; aún no se ha verificado en cadena.',
    payoutMissing:
      'Premio: {amount}, pero este mensaje incluía {carried}. No se te ha pagado el total.',
    awaiting: 'Esperando a que el bot revele el secreto ({seconds} s).',
    noAnswer:
      'El bot no ha respondido después de {seconds} s. Tu apuesta está en poder del bot y no se ha revelado nada.',
  },
  raffleDraw: {
    verified: 'El sorteo coincide con el compromiso de la semilla',
    failed: 'La verificación falló: {reason}',
    explainerToggle: '¿Qué demuestra esto?',
    explainerShows:
      'Demuestra que el operador no cambió la semilla tras comprometerse a ella y que el ganador se deriva de los participantes enumerados y esa semilla.',
    explainerNotShown:
      'No demuestra que los participantes enumerados correspondan a pagos reales en cadena ni que no se hayan omitido participaciones.',
    explainerCountUnverified:
      'La ronda no anunció su tamaño, por lo que no se comprueba el número de participantes.',
  },
  persistentStorage: {
    tab: 'Almacenamiento',
    heading: 'Almacenamiento persistente',
    granted: 'Concedido',
    notGranted: 'No concedido',
    unsupported: 'No disponible',
    unknown: 'Comprobando…',
    explainGranted:
      'Tu navegador ha aceptado proteger los datos guardados de Frank frente a la eliminación automática. Borrar los datos del sitio web aún puede eliminarlos. Conserva una copia de seguridad independiente de tu cuenta.',
    explainNotGranted:
      'Frank ya guarda datos en este dispositivo. Este permiso añade protección frente a la eliminación automática; no añade espacio en disco. Sin él, el navegador puede borrar los datos guardados. Conserva una copia de seguridad independiente de tu cuenta.',
    explainUnsupported:
      'Este navegador o contexto no ofrece protección frente a la eliminación automática. Frank puede guardar datos, pero el navegador puede borrarlos. Conserva una copia de seguridad independiente de tu cuenta.',
    request: 'Pedir al navegador que conserve mis datos',
    confirmSeed: 'Confirmar mi frase de recuperación',
    seedConfirmed: 'Tu frase de recuperación está confirmada.',
    safariTip:
      'Safari en Mac (macOS Sonoma 14 o posterior): elige Archivo > Añadir al Dock, abre Frank desde el Dock y vuelve a solicitar protección. En iPhone o iPad, usa Compartir > Añadir a la pantalla de inicio y abre Frank desde allí. El navegador sigue decidiendo si concede protección; guardar un marcador no la garantiza.',
    grantedToast: 'El navegador ha concedido almacenamiento persistente.',
    declinedToast:
      'El navegador no ha concedido protección frente a la eliminación automática. Tus datos siguen guardados. Consulta las indicaciones de instalación de abajo y vuelve a intentarlo; la protección no está garantizada.',
  },
  blackjackP2p: {
    cancel: 'Cancelar',
    challengeDealerReview:
      'El otro jugador elige una apuesta dentro de este límite.',
    challengeBetLimit: 'Límite de apuesta',
    challengeBeforeBet:
      'Esto abre una mano. Revisa y confirma tu apuesta cuando acepte el crupier.',
    preparingChallenge: 'Preparando desafío…',
    betSummary: 'Apuesta: {amount}',
    changeBet: 'Cambiar',
    confirmBet: 'Apostar {amount}',
    notDeliveredYet:
      'La otra parte aún no tiene este mensaje: se está enviando.',
    notDelivered: 'La otra parte no tiene este mensaje: no se envió. {reason}',
    retry: 'Volver a enviarlo',
    notNext:
      'Esta jugada de blackjack ya se envió o ya no es posible. No se envió nada.',
    cardDealtN: 'Carta: {card}',
    playAgain: 'Jugar de nuevo',
    challengeTitle: 'Desafiar a una mano de blackjack',
    roleDealer: 'Yo reparto',
    rolePlayer: 'Yo juego, la otra persona reparte',
    maxBet: 'Apuesta máxima',
    limitDealer:
      'Puedes ofrecer hasta {amount}: el crupier debe poder pagar una victoria con apuesta doblada (4× la apuesta) con su propio saldo.',
    limitPlayer: 'Puedes apostar hasta {amount}: lo que puedes gastar ahora.',
    sendChallenge: 'Enviar desafío',
    challengeRefused:
      'Este desafío supera lo que cubre tu saldo. No se envió nada.',
    balanceUnknown: 'Tu saldo aún no se ha cargado.',
    enterAmount: 'Introduce un importe mayor que cero.',
    belowStamp: 'El importe no puede ser inferior al sello mínimo ({amount}).',
    aboveOwnLimit: 'Eso supera lo que puedes cubrir (como máximo {amount}).',
    aboveMaxBet: 'Eso supera la apuesta máxima de esta mano ({amount}).',
    lineChallengeDealer:
      'Desafío de blackjack: quien envía reparte. Apuesta máxima {amount}.',
    lineChallengePlayer:
      'Desafío de blackjack: quien envía juega, tú repartes. Apuesta máxima {amount}.',
    lineAccept: 'Desafío aceptado. Apuesta máxima {amount}.',
    line: {
      bet: 'Apuesta realizada: el sello de este mensaje es la apuesta.',
      deal: 'Cartas repartidas.',
      hit: 'Pedir carta.',
      stand: 'Plantarse.',
      double: 'Doblar: el sello de este mensaje es la segunda apuesta.',
      card: 'Carta repartida.',
      reveal:
        'Mano revelada: el sello de este mensaje es el premio, si lo hay.',
      refund: 'Reembolso: el sello de este mensaje es el dinero devuelto.',
    },
    playerHand: 'Jugador: {cards} ({total})',
    dealerHand: 'Crupier: {cards} ({total})',
    dealerShows: 'El crupier muestra: {card}',
    rowPlayer: 'Jugador',
    rowDealer: 'Crupier',
    rowCard: 'Carta',
    wager: 'En juego: {amount}',
    accept: 'Aceptar y repartir',
    betAmount: 'Tu apuesta (como máximo {max})',
    bet: 'Apostar',
    hit: 'Pedir carta',
    stand: 'Plantarse',
    double: 'Doblar (+{amount})',
    payAndReveal: 'Pagar {amount} y revelar',
    refund: 'Reembolsar {amount}',
    refundBet: 'Devolver la apuesta ({amount}) en vez de repartir',
    waitAccept: 'Esperando a que acepte la otra parte.',
    waitBet: 'Esperando la apuesta.',
    waitDealer: 'Esperando al crupier.',
    waitPlayer: 'Esperando la jugada del jugador.',
    waitReveal: 'Esperando a que el crupier revele y pague.',
    dealing: 'Repartiendo…',
    verified:
      'Las cartas provienen de los compromisos de ambos jugadores, comprobados en este dispositivo.',
    badReveal:
      'El crupier envió una revelación que no coincide con su compromiso. La mano no está liquidada.',
    noSeed:
      'Este dispositivo no tiene la semilla de esta mano y no puede repartir. Puedes devolver la apuesta.',
    noSeedPlayer:
      'Este dispositivo no tiene tu semilla de esta mano y no puede realizar tu jugada. Usa el dispositivo donde apostaste.',
    refundOwed: 'El crupier te debe un reembolso de {amount}.',
    refunded: 'El crupier devolvió la apuesta ({amount}).',
    noPayout: 'No se paga ningún premio.',
    paid: 'El crupier pagó {amount}.',
    shortPaid: 'El crupier debía {owed}, pero pagó {paid}.',
    outcome: {
      player: {
        player_win: 'Ganas.',
        dealer_win: 'Gana el crupier.',
        push: 'Empate: recuperas tu apuesta.',
        player_blackjack: '¡Blackjack! Ganas 3:2.',
      },
      dealer: {
        player_win: 'Gana el jugador.',
        dealer_win: 'Ganas.',
        push: 'Empate: se devuelve la apuesta.',
        player_blackjack: 'El jugador tiene blackjack y gana 3:2.',
      },
    },
  },
  a11y: {
    contactActions: 'Opciones de contacto para {name}',
    openNavigation: 'Abrir menú de navegación',
    addContact: 'Añadir contacto',
    addTopic: 'Añadir tema',
    deleteTopic: 'Eliminar tema {topic}',
    deleteContact: 'Eliminar contacto {name}',
    sendMessage: 'Enviar mensaje',
    voteUp: 'Votar a favor',
    voteDown: 'Votar en contra',
    forumRefresh: 'Actualizar foro',
    newPost: 'Nueva publicación',
    forumSettings: 'Configuración del foro',
    topicSettings: 'Configuración del tema',
    chatMenu: 'Opciones del chat',
    closeInfo: 'Volver al chat',
    exitSelectMode: 'Salir de la eliminación de mensajes',
    attachmentOptions: 'Opciones de adjuntos',
    stampPayment: 'Pago del sello',
    messageActions: 'Mostrar acciones del mensaje',
    replyToMessage: 'Responder al mensaje',
    forwardMessage: 'Reenviar mensaje',
    messageInfo: 'Información del mensaje',
    deleteMessage: 'Eliminar mensaje',
    resendMessage: 'Volver a enviar mensaje',
    cancelReply: 'Cancelar respuesta',
    scrollToLatest: 'Ir a los mensajes más recientes',
    copyAddress: 'Copiar dirección',
    connectRelay: 'Conectar al servidor de retransmisión',
    choosePhoto: 'Elegir foto de perfil',
    previousAvatar: 'Avatar anterior',
    nextAvatar: 'Avatar siguiente',
    openInExplorer: 'Abrir transacción en el explorador de bloques',
    copyTxHash: 'Copiar hash de transacción',
    backToForum: 'Volver al foro',
    formatBold: 'Aplicar negrita',
    formatItalic: 'Aplicar cursiva',
    formatHeading: 'Aplicar encabezado',
    formatQuote: 'Aplicar cita',
    formatCode: 'Aplicar código',
    formatBullet: 'Aplicar lista con viñetas',
    formatLink: 'Insertar enlace',
    attachPostImage: 'Adjuntar imagen a la publicación',
    formatting: 'Formato',
  },
  leftDrawer: {
    noForums: 'Aún no se han encontrado foros.',
    settings: 'Configuración',
    chats: 'Mensajes directos',
    contacts: 'Contactos',
    forum: 'Foro',
    wallet: 'Cartera',
    railLabel: 'Secciones de la barra lateral',
    chatsUnreadOne: 'Mensajes directos, {count} mensaje sin leer',
    chatsUnreadOther: 'Mensajes directos, {count} mensajes sin leer',
    contactsUnreadOne: 'Contactos, {count} mensaje sin leer',
    contactsUnreadOther: 'Contactos, {count} mensajes sin leer',
    loginSignUp: 'Iniciar sesión / Registrarse',
    welcome: 'Introducción',
  },
  welcome: {
    title: 'Bienvenido a Frank',
    tagline: 'La libertad de expresión tiene un coste.',
    subtitle: 'Mensajería privada en Monad con resistencia económica al spam.',
    introText:
      'Frank combina identidades criptográficas sin permiso con valor económico real en juego. Quien envía paga por la atención, las publicaciones públicas queman valor y las transacciones privadas preservan la privacidad en el conjunto de la red.',
    createAccount: 'Crear cuenta',
    createAccountSubtitle:
      'Genera una identidad criptográfica local en segundos, sin datos personales identificativos.',
    browseForum: 'Explorar el foro',
    browseForumSubtitle:
      'Lee temas públicos y debates de la comunidad sin una cuenta.',
    readDocs: 'Leer documentación',
    howItWorks: 'Cómo funciona Frank',
    pillarFreeSpeechTitle: 'La libertad de expresión tiene un coste',
    pillarFreeSpeechDesc:
      'Cuando los mensajes no cuestan nada, los bots dominan y las plataformas censuran. Frank reemplaza a los intermediarios con incentivos económicos: los mensajes directos pagan al destinatario y los temas públicos queman valor.',
    pillarPrivacyTitle: 'Privacidad en la red y DKSAP',
    pillarPrivacyDesc:
      'Los pagos se dirigen a direcciones privadas derivadas de un solo uso. Las transacciones parecen transferencias corrientes de gas entre particulares, creando privacidad de grupo en toda la cadena de bloques.',
    pillarIdentityTitle:
      'Identidad soberana sin datos personales identificativos',
    pillarIdentityDesc:
      'No se necesitan números de teléfono, códigos SMS ni correo electrónico. Tu identidad es un par de claves secp256k1 local derivado íntegramente en tu dispositivo.',
    pillarRelayTitle: 'Servidores de retransmisión de buzones federados',
    pillarRelayDesc:
      'Los servidores enrutan y almacenan sobres cifrados de extremo a extremo sin ver nunca el texto de los mensajes ni controlar el acceso a las identidades.',
  },
  docs: {
    title: 'Documentación',
    header: 'Documentación y protocolo',
    openInTab: 'Abrir en una pestaña',
    iframeTitle: 'Documentación de Frank',
  },
  walletPanel: {
    title: 'Carteras',
    mainWallet: 'Cartera principal',
    renameWallet: 'Cambiar nombre de la cartera',
    walletName: 'Nombre de la cartera',
    saveName: 'Guardar',
    cancel: 'Cancelar',
    resetDefault: 'Restablecer valor predeterminado',
    testnet: 'Red de prueba',
    monad: 'Monad',
    monadTestnet: 'Monad Testnet',
    send: 'Enviar MON',
    receive: 'Recibir MON',
    sendMont: 'Enviar MONT',
    receiveMont: 'Recibir MONT',
    showSeed: 'Mostrar frase de recuperación',
    confirmSeed: 'Confirmar frase de recuperación',
    balanceLoading: 'Cargando el saldo…',
    relayUnavailable:
      'No disponible a través de este servidor de retransmisión.',
    balanceUnavailable: 'Saldo no disponible.',
    balanceUnsupported: 'Aún no se muestra el saldo de esta red.',
    walletUnsupported:
      'Esta red aún no es compatible. No se muestra una dirección porque la aplicación no podría detectar dinero enviado a ella.',
    notSupported: 'No compatible',
    tokenBalancesLoading: 'Cargando saldos de tokens…',
    tokenBalancesUnavailable: 'Saldos de tokens no disponibles.',
    tokenBalancesStale:
      'Saldos de tokens no disponibles. Se muestran los últimos saldos conocidos.',
    balanceStale: '{balance} (último conocido)',
    failedLoadAddress: 'No se pudo derivar la dirección de la cartera',
    receiveDiscoveryUnavailable:
      'No se pudo comprobar la siguiente dirección de recepción sin usar a través del servidor de retransmisión. Reintenta cuando haya conexión.',
    receiveAddressUnavailable:
      'La dirección de recepción no está disponible para esta cuenta y red. Intenta abrirla de nuevo.',
    retryAddress: 'Reintentar dirección',
    unableCopyAddress: 'No se puede copiar la dirección de Monad',
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
    receiveXec: 'Recibir XEC',
    receiveTxec: 'Recibir tXEC',
    sendAsset: 'Enviar {unit}',
    sendSol: 'Enviar SOL',
    receiveSol: 'Recibir SOL',
    sendTsol: 'Enviar tSOL',
    receiveTsol: 'Recibir tSOL',
    sendToContact: 'Enviar a un contacto',
    legacySend: 'Envío tradicional',
    avuDialogTitle: 'Unidad de Valor Arbitraria (AVU)',
    avuDialogSubtitle: '1 AVU ≡ 1 kilovatio-hora (kWh) de cómputo físico',
    avuDialogDesc:
      'Frank mantiene las monedas fiduciarias fuera de la interfaz. Los saldos se comparan en AVU, una unidad de cuenta: 1 AVU es 1 kWh de energía. La energía que representa una unidad de valor se obtiene de la minería de prueba de trabajo (el precio, la recompensa por bloque, la dificultad y la eficiencia del hardware de minería de una cesta de monedas minadas), y el valor AVU de una moneda es su precio multiplicado por esa cifra. No es una moneda ni un token; permite comparar dos monedas con un solo número.',
    avuMemeHeading: 'Rechazar el meme del USD',
    avuMemeDesc:
      'El dólar estadounidense es un meme social sostenido por los valores predeterminados del software y los decretos de los bancos centrales. Rechazar la visualización de USD en carteras de autocustodia rompe ese monopolio psicológico y debilita el meme, anclando de nuevo la riqueza en las leyes invariantes de la termodinámica.',
    avuSupplyChainHeading: 'La raíz de toda cadena de suministro',
    avuSupplyChainDesc:
      'Todo bien físico —alimentos, agua limpia, vivienda, semiconductores y transporte— es, fundamentalmente, energía organizada. Al expresar el valor en energía física, el poder adquisitivo se mide frente al coste raíz de la realidad física.',
    avuCpiHeading: 'Más allá del IPC: revelar el valor real del dólar',
    avuCpiDesc:
      'Los indicadores oficiales del índice de precios al consumidor (IPC) ocultan la inflación mediante sesgos de sustitución y ajustes hedónicos. Un billete de $100 sigue diciendo "$100", ocultando su deterioro. En 1960, $1 compraba unos 91 kWh de electricidad industrial estadounidense; en 2025 compraba unos 12 kWh (EIA). Seguir la energía en el tiempo revela el ritmo de pérdida de valor de la moneda fiduciaria.',
    avuOracleLessHeading: 'Realmente «sin oráculos»',
    avuOracleLessDesc:
      'A diferencia de los oráculos DeFi tradicionales que dependen de fuentes de terceros de confianza, los nodos completos verifican directamente en cadena la dificultad de prueba de trabajo y los calendarios de emisión, anclados en la competencia termodinámica.',
    avuDialogClose: 'Cerrar',
    avuDrawerHeader: '1 AVU ≡ 1 kWh (?)',
    avuRatesTitle: 'Lo que vale una unidad en AVU',
    avuRatesAsset: 'Activo',
    avuRatesRate: 'Cómputo físico (AVU / kWh)',
    tabBalance: 'Saldo y transferencias',
    priceHistoryTitle: 'Historial de precios de {symbol}',
    priceHistoryAxisHash: 'AVU (Hash) por {symbol}',
    priceHistoryAxisSpot: 'AVU (Spot) por {symbol}',
    priceHistoryAxisGold: 'Onzas troy de oro por {symbol}',
    priceHistoryHash: 'AVU (Hash)',
    priceHistorySpot: 'AVU (Spot)',
    priceHistoryGold: 'Oro',
    priceHistoryPoints: '{count} observaciones de precios desde {first}.',
    priceHistoryCoverage:
      '{count} observaciones de precios disponibles de {first} a {last}. Intervalo solicitado: {range}.',
    priceHistorySinglePoint:
      'Solo hay una observación de precio en este intervalo; no se traza ninguna línea.',
    priceHistoryGoldUnavailable:
      'No hay un precio de oro reciente y fechado para estas observaciones.',
    priceHistorySource: 'Fuente del precio: {source}.',
    priceHistoryBenchmarkUnavailable:
      'No hay valoración {benchmark} de esta moneda en este intervalo.',
    avuReferenceTitle: 'Valor de AVU en dólares estadounidenses',
    avuReferenceAxis: 'USD por AVU',
    avuReferenceHash: '1 AVU (Hash)',
    avuReferenceSpot: '1 AVU (Spot)',
    avuReferenceNoHistory:
      'No hay historial de referencia de AVU en este intervalo.',
    avuReferenceSinglePoint:
      'Solo hay una observación para un indicador de referencia; no se traza una línea para él.',
    avuReferencePointCount: '{count} observaciones',
    avuReferenceMethod: 'Cómo se calcula AVU',
    avuReferenceMethodText:
      'AVU (Hash) valora la energía mediante la minería de prueba de trabajo; AVU (Spot) usa precios mayoristas de electricidad. El valor en dólares de cada uno es el inverso de su energía por dólar. Los datos faltantes permanecen no disponibles.',
    aboutAvu: 'Acerca de AVU',
    tabHistory: 'Historial',
    historyEmpty: 'Aún no hay actividad registrada en esta red.',
    historyPending: 'Pendiente y sin resolver',
    historyUndated: 'Fecha no disponible',
    backToWallet: 'Volver a la cartera',
    avuReferenceMeasurement:
      'Una AVU representa un kilovatio-hora. Estas curvas muestran su valor en dólares estadounidenses usando mediciones de minería y electricidad mayorista.',
    avuReferenceSampling:
      'La medición de minería usa precios de monedas, ingresos observados de minería y tasa de hash, eficiencia del hardware y ponderaciones por capitalización de mercado. Los datos históricos incluyen promedios mensuales y cambios fechados; cada valor se mantiene hasta su siguiente observación. Los cambios de la curva pueden venir de cualquiera de estos datos, no solo de la tasa de hash.',
    tabParity: 'Historial de precios',
    tabSwap: 'Intercambio instantáneo',
    swapUnavailable: 'Intercambio instantáneo no disponible',
    swapUnavailableDescription:
      'Los intercambios aún no son compatibles. No hay cotizaciones ni transacciones disponibles.',
    assetsAndTokens: 'Activos y tokens',
    nativeCoin: 'Moneda nativa',
    splToken: 'Token SPL',
    tokenMint: 'Mint del token',
    tokenContract: 'Contrato del token',
    recentActivity: 'Intercambios recientes',
    noRecentActivity: 'Aún no hay intercambios en esta cadena.',
    swapAction: 'Intercambiar',
    viewInExplorer: 'Ver en el explorador',
    avuTooltip:
      '1 AVU ≡ 1 kWh (3.6 MJ) de cómputo físico. Un estándar termodinámico infalsificable de poder adquisitivo real.',
    avuHashLabel:
      'AVU_hash: energía por unidad de valor, a partir de la minería',
    avuHashNote:
      'Promedio de la cesta de monedas minadas, ponderado por capitalización de mercado con Bitcoin limitado al 60%: {weights}. Litecoin y Dogecoin se minan juntos y cuentan como una entrada. La eficiencia del hardware se selecciona manualmente: la estimación de Cambridge de las máquinas en funcionamiento para SHA-256, la mejor máquina a la venta para scrypt y RandomX. La mejor máquina es más eficiente que un conjunto de equipos, así que esas dos entradas dan valores por kWh superiores a los de un conjunto comparable.',
    avuSpotLabel:
      'AVU_spot: electricidad mayorista, valorada como la minería valora la energía',
    avuSpotNote:
      'En 1 AVU coinciden la red eléctrica y la minería. Precio: media del precio del día siguiente de cada región durante los {window} días hasta {latest}, con igual peso por región: {regions}.',
    avuUnitLabel: 'La unidad',
    avuUnitNote:
      'Una unidad de cuenta, no una moneda ni un token: no se mantiene ni intercambia nada en AVU.',
    avuUnavailable: 'No disponible',
    sourceEfficiency:
      'Eficiencia del hardware (seleccionada manualmente, no una lectura en vivo): {sources}.',
    avuHashVsSpotNote:
      'Lo que gana un kWh de minería frente a lo que cuesta un kWh al por mayor. Ambos deberían coincidir aproximadamente.',
    avuHashVsSpotLabel:
      'Remuneración de la minería frente al precio de la red eléctrica',
    avuHashStale: 'Desactualizado: el dato más antiguo tiene {age}.',
    avuHashLeftOutEfficiency: 'sin cifra de eficiencia del hardware',
    avuHashLeftOutPrice: 'sin precio',
    avuHashLeftOutChain: 'sin estadísticas de la cadena',
    avuHashLeftOut: 'Excluidos: {coins}.',
    avuHashUnavailableNote:
      'No se pudo calcular AVU_hash: ninguna moneda minada de la cesta tiene precio y estadísticas de la cadena. No se muestra ningún valor AVU hasta que alguna los tenga.',
    avuPriceFreshNote: 'Precio recibido hace {age}.',
    avuPriceStaleNote: 'Desactualizado: último precio recibido hace {age}.',
    avuStalePrice: '{rate} (antigüedad: {age})',
    resetZoom: 'Restablecer zoom',
    chartGoldAvu: 'Oro (AVU por onza)',
    rangeAll: 'TODO',
    range5Y: '5Y',
    range1Y: '1Y',
    range30D: '30D',
    range7D: '7D',
    range24H: '24H',
    rangeNetworks: 'Redes',
    chartNoteNoHistory:
      'Aún no hay historial para este intervalo, por lo que no se traza ninguna línea.',
    chartNoteNetworks:
      'Lo que gana un kWh de minería en cada entrada de la cesta, en AVU, con el peso de la entrada: precio × recompensa por bloque del minero ÷ hashes esperados por bloque × hashes por kWh, valorado por la cesta. El porcentaje lo compara con la cesta completa (1 AVU por kWh).',
    chartNoteNetworksUnavailable:
      'No se pudo calcular AVU_hash, por lo que no se traza nada.',
    sourcesTitle: 'Metodología y fuentes de datos',
    sourceUnit:
      'AVU: 1 AVU = 1 kWh. AVU_hash es la energía que representa una unidad de valor, promediada sobre una cesta de monedas minadas por capitalización de mercado con Bitcoin limitado al 60%; para cada entrada, remuneración por kWh = precio × recompensa por bloque del minero ÷ hashes esperados por bloque × hashes por kWh. Cada valor AVU es un precio multiplicado por AVU_hash.',
    avuHashValue: '{used} de {total} entradas de la cesta',
    avuFeesExcluded:
      'Las comisiones de minería no están disponibles para parte de esta estimación; esos datos usan solo el subsidio del minero.',
    avuHashEstimated: 'Una entrada se basa en una cifra estimada del hardware.',
    avuSpotValue: 'Un kWh mayorista cuesta {avu} AVU',
    avuSpotStale: 'Sin actualizar: el último precio tiene {age}.',
    avuSpotNotPositive:
      'El precio mayorista medio no es mayor que cero, por lo que no tiene inverso.',
    avuSpotNoData: 'No se ha recibido ningún precio mayorista de electricidad.',
    avuUnitValue: '1 AVU = 1 kWh',
    avuNoPrice:
      'El oráculo no tiene precio para esta moneda, así que no tiene valor AVU.',
    avuTestnetValue: '{rate} · red de prueba',
    chartGridAvu: 'Un kWh de electricidad mayorista (AVU)',
    chartNoteLines:
      '{count} puntos desde {first}. Cada uno se calcula para su fecha con la misma fórmula que las cifras actuales, usando los precios, estadísticas de cadena, eficiencia del hardware y precio de electricidad vigentes entonces. Donde falta un dato, no hay punto.',
    chartNoteNoTokenPrice:
      'No hay historial de precios de {symbol} en este intervalo.',
    chartNoteEstimated:
      'La eficiencia del hardware de Monero antes del primer ASIC (septiembre de 2023) es una estimación: un procesador de escritorio en su límite de potencia de encapsulado, excluyendo el resto del equipo.',
    chartNoteTestnet:
      'Las monedas de prueba se valoran al precio de la moneda de la red principal.',
    chartNoteNoFeed:
      'Aún no se ha recibido nada del oráculo, por lo que no se traza nada.',
    sourcePrices: 'Precios: {sources}.',
    sourceChains:
      'Dificultad, recompensa por bloque y suministro: {sources}. La dificultad de Dogecoin es su cifra de 24 horas.',
    sourceElectricity: 'Electricidad mayorista: {sources}.',
    sourceGold:
      'Oro: World Bank Commodity Price Data (Pink Sheet), anual, valorado al AVU_hash de mediados de año.',
    avuSpotRegionsLeftOut:
      'Excluidas de esta cifra por falta de precios recientes: {regions}.',
    avuSpotRegionLast: '{region} (último cómputo: {day})',
    avuHashVsSpotLess:
      'La minería paga un {percent}% menos por kWh que lo que cobra la red eléctrica.',
    avuHashVsSpotMore:
      'La minería paga un {percent}% más por kWh que lo que cobra la red eléctrica.',
    sourceEcashShare:
      'Los mineros de eCash reciben {share} de la recompensa por bloque desde {since} ({previous} antes), según la cadena.',
    activeTokenCardTitle: '{symbol} en AVU',
    inspectingDate: 'Consultando',
    latestValue: 'Más reciente',
  },
  chatList: {
    senderPrefix: '{name}: {text}',
    noContactMessage: 'Añade contactos desde el panel de arriba...',
    youPrefix: 'Tú: {text}',
    themPrefix: 'La otra persona: {text}',
    balance: 'Saldo',
    balanceStale: '(último conocido)',
    directMessages: 'Mensajes directos',
    composeEmail: 'Redactar correo',
    openingConversation: 'Abriendo conversación…',
    selectChatOrAddContact:
      'Selecciona una conversación o añade un contacto para empezar a escribir.',
    searchPlaceholder: 'Buscar mensajes, asuntos, contactos… (⌘K)',
    clearSearch: 'Borrar búsqueda',
    noSearchResults:
      'No se encontraron mensajes ni conversaciones coincidentes.',
    screenerFilterLabel: 'Filtro de solicitudes ({count}) · {value}',
    screenerFilterEmpty:
      'No hay solicitudes de desconocidos con pago pendientes.',
    allConversationsFilter: 'Todas',
    screenerBannerTitle:
      'Filtro de peaje: quien envía pagó {value} en sellos para contactarte',
    screenerApprove: 'Aprobar y añadir contacto',
    screenerReplyOnce: 'Responder una vez',
    screenerDismissKeepStamp: 'Descartar y conservar el sello',
  },
  selfChat: {
    you: 'Tú',
  },
  outgoing: {
    sending: 'Enviando…',
    paymentPending:
      'Pago pendiente, se reintentará. No se te cobrará de nuevo.',
    paymentQueued:
      'Esperando a que termine un mensaje anterior. Este se enviará después.',
    paymentChecking: 'Comprobando el estado del pago…',
    waitingForPreviousPayment: 'Esperando la confirmación del pago anterior…',
    waitingForChain: 'En cola: no se puede acceder a la red.',
    waitingBlocks:
      'Esperando {blocks} bloques más tras el pago anterior antes de pagar…',
    paymentSent: 'Enviado',
    paymentInMempool: 'Sello del mensaje en la mempool',
    paymentPaid: 'Sello pagado',
    paymentReverted: 'Sello del mensaje revertido, pagando de nuevo',
    paymentRepaid: 'Sello revertido, pagado de nuevo',
    paymentFailed: 'El sello del mensaje falló',
    paymentUnsent: 'Sello del mensaje no pagado',
    reasonUnreachable: 'No se puede acceder al servidor.',
    reasonUnavailable: 'Este servidor de retransmisión no ofrece mensajería.',
    reasonRejected: 'El servidor de retransmisión lo rechazó.',
    reasonInterrupted: 'Se interrumpió antes de enviarse.',
    reasonUnverified: 'No se pudo confirmar la entrega.',
    reasonRecovered: 'Mientras tanto se entregó un mensaje anterior.',
    reasonInsufficientFunds:
      'No hay fondos suficientes para enviar este mensaje.',
    reasonRecipientUnregistered:
      'El destinatario no está registrado en este servidor de retransmisión.',
    reasonStampBelowFee:
      'La comisión de red superó el valor de este sello antes de enviarse. No se pagó nada. Reintentar lo envía con el sello mínimo actual.',
    reasonError: 'No se pudo enviar el mensaje.',
    retry: 'Reintentar',
    retryHint:
      'Reintentar vuelve a enviar el mismo pago mientras siga siendo válido. Solo se hace un pago nuevo si ya no lo es.',
    discard: 'Descartar',
    discardConfirmTitle: '¿Descartar mensaje?',
    discardConfirmMessage:
      'Esto lo elimina de tu conversación. Si su pago sigue pendiente, aún puede entregarse.',
    discardFailedConfirmMessage:
      'Esto elimina el mensaje fallido de tu conversación. No se gastaron fondos.',
    sendAgainTitle: '¿Volver a enviar?',
    sendAgainUnverified:
      'No pudimos confirmar si se entregó el primer pago. Volver a enviar puede cobrarte por segunda vez.',
    sendAgainRecovered:
      'Se entregó un mensaje anterior pendiente mientras se enviaba este. ¿Enviar este de nuevo como mensaje nuevo?',
    sendAgain: 'Volver a enviar',
  },
  mailboxStatus: {
    directory: {
      'device-clock':
        'Mensajería desactivada: la fecha y hora de este dispositivo parecen incorrectas. Revisa el reloj; reintentando.',
      'account-unavailable':
        'Mensajería desactivada: no se pudo abrir esta cuenta para mensajería. Reintentando.',
      'relay-unreachable':
        'Mensajería desactivada: no se puede acceder al servidor para publicar tu cuenta. Reintentando.',
      'relay-rejected':
        'Mensajería desactivada: el servidor rechazó guardar la entrada de dirección de tu cuenta. Reintentando.',
      'relay-misconfigured':
        'Mensajería desactivada: el servidor no se describió correctamente, por lo que no se pudo publicar tu cuenta. Reintentando.',
      'entry-refused':
        'Mensajería desactivada: el servidor contiene una entrada incompatible o no válida para tu cuenta. Reintentando.',
      'storage':
        'Mensajería desactivada: este dispositivo no pudo guardar los registros de su libreta de direcciones. Reintentando.',
    },
    unavailable:
      'Servicio de mensajería no disponible: este servidor de retransmisión no ofrece mensajería, por lo que no recibirás mensajes.',
    unreachable:
      'No se puede acceder al servidor. Es posible que no estés recibiendo mensajes; reintentando.',
    rateLimited: 'El servidor pidió reducir el ritmo. Se reintentará en breve.',
    unauthorized:
      'El servidor rechazó tu inicio de sesión de mensajería. Reintentando.',
  },
  chatMessage: {
    notInContacts: 'No está en tus contactos',
    openSender: 'Abrir el perfil de {name}',
    noPayloadFound: 'No se encuentra el contenido del mensaje',
    failedToSend: 'No se pudo enviar',
    showActions: 'Mostrar acciones del mensaje',
    replyMessage: 'Responder al mensaje',
    forwardMessage: 'Reenviar mensaje',
    infoMessage: 'Información del mensaje',
    deleteMessage: 'Eliminar mensaje',
  },
  chatMessageMenu: {
    reply: 'Responder',
    forward: 'Reenviar',
    copy: 'Copiar texto',
    stampTransaction: 'Transacción del sello',
    resend: 'Volver a enviar',
    discard: 'Descartar',
    delete: 'Eliminar',
    messageCopied: 'Mensaje copiado al portapapeles',
  },
  chatListMenu: {
    openChat: 'Abrir chat',
    viewProfile: 'Ver perfil',
    copyAddress: 'Copiar dirección',
    mute: 'Silenciar notificaciones',
    unmute: 'Activar notificaciones',
    deleteChat: 'Eliminar conversación',
  },
  notifications: {
    addressCopied: 'Dirección copiada al portapapeles.',
    insufficientStamp:
      'El sello es demasiado pequeño; el destinatario no recibirá una notificación.',
    seedCopied: 'Tu frase de recuperación se ha copiado al portapapeles.',
    sentTransaction: 'Transacción enviada',
    unexpectedError: 'Algo salió mal. Vuelve a intentarlo.',
    viewAction: 'Ver',
  },
  chatRightDrawer: {
    deleteContactAndConversations: 'Eliminar contacto y conversaciones',
    stampPrice: 'Precio del sello',
    sendLotus: 'Enviar Lotus',
    notifications: 'Notificaciones',
    clearHistory: 'Borrar historial',
    deleteChat: 'Eliminar chat',
    unknownContact: 'Desconocido',
    usernameReassigned:
      'Añadiste este contacto como {username}. Ahora ese nombre de usuario pertenece a otra cuenta. Este contacto sigue siendo la cuenta que añadiste y tus mensajes siguen llegando a ella.',
  },
  sendStealthDialog: {
    nativeBalance: 'Saldo nativo',
    insufficientFunds:
      'Saldo del activo o saldo nativo insuficiente para este pago y su comisión de red.',
    insufficientBalance: 'El importe supera el saldo disponible',
    assetLabel: 'Activo y red',
    reviewBtnLabel: 'Revisar pago',
    checkingQuote: 'Comprobando saldos y comisiones…',
    recipientAmount: 'Importe para el destinatario',
    nativeFee: 'Comisión de red',
    feeCeiling: 'Comisión de red máxima',
    messageStampFee: 'Comisión de red estimada del mensaje',
    messageStamp: 'Sello del mensaje',
    preparing: 'Preparando pago privado: {amount}',
    sendStealthTo: 'Enviar pago privado a',
    subtitle:
      'Se paga desde tu cartera a una dirección de un solo uso desde la que solo este contacto puede gastar',
    balanceLabel: 'Disponible para este pago:',
    amountHint: 'Importe a pagar',
    amountPlaceholder: '0.0',
    memoHint: 'Nota enviada con el pago (opcional)',
    memoPlaceholder: 'Introduce una nota...',
    sendBtnLabel: 'Enviar',
    cancelBtnLabel: 'Cancelar',
    sent: 'Pago enviado',
    pending:
      'Pago guardado. Su mensaje sigue en proceso de entrega; se paga cuando llega el mensaje. No lo envíes de nuevo.',
    notSent: 'No se pudo realizar el pago. No se envió nada.',
    messageEnded:
      'El pago está guardado y su mensaje no se pudo entregar. Abre el chat con este contacto y reintenta el mensaje: no se ha pagado nada y nada se paga dos veces.',
    tooLarge:
      'Este pago supera lo que puede incluir un solo pago a un contacto (unos {max} {unit}); envíalo por partes.',
  },
  offerSwapDialog: {
    title: 'Ofrecer intercambio atómico a',
    subtitle: 'Intercambio atómico entre cadenas sin necesidad de confianza',
    youPay: 'Ofreces (pagas)',
    youReceive: 'Recibes',
    offeredChain: 'Cadena ofrecida',
    requestedChain: 'Cadena solicitada',
    offerBtnLabel: 'Ofrecer intercambio',
    cancelBtnLabel: 'Cancelar',
  },
  chatMessageSwap: {
    notAvailableYet:
      'Los intercambios atómicos aún no están disponibles. Desde aquí no se puede bloquear, reclamar ni reembolsar nada.',
    title: 'Oferta de intercambio atómico',
    offered: 'Ofrecido',
    for: 'A cambio de',
    accept: 'Aceptar intercambio',
    cancel: 'Cancelar oferta',
    lockDeposit: 'Depositar y bloquear {amount} {asset}',
    acceptAndLock: 'Aceptar y bloquear {amount} {asset}',
    claimFunds: 'Reclamar {amount} {asset}',
    refundDeposit: 'Reembolsar depósito',
    activeOnOtherDevice: 'Activo en {device}',
    takeOverActive: 'Usar aquí',
    viewTx: 'Ver transacción de {chain}',
    statusUnfunded: 'Sin fondos',
    statusLocked: 'Bloqueado en custodia',
    statusWithdrawn: 'Retirado',
    statusRefunded: 'Reembolsado',
    statusExpired: 'Caducado',
    processing: 'Procesando...',
  },
  balanceBreakdown: {
    open: 'Dónde está este saldo',
    main: 'Cuenta principal',
    mainNote: 'Tu dirección de depósito: la que se muestra abajo.',
    profile: 'Dirección del perfil',
    profileNote: 'Enviado a la dirección de tu perfil.',
    received: 'Pagos recibidos ({count})',
    receivedNote:
      'Pagos y sellos que te enviaron, cada uno en su propia dirección de un solo uso, confirmados en la red.',
    other: 'Cuentas de envío',
    otherNote:
      'La cartera los reserva en sus propias cuentas para pagar tus próximos mensajes. Forman parte del saldo de arriba.',
    total: 'Saldo',
    yours:
      'Todas estas cuentas pertenecen a esta cartera y se recuperan con tu frase de recuperación.',
    unavailable: 'No se pudieron leer las cuentas en este momento.',
  },
  heldContactPayments: {
    title: 'Pagos a contactos en curso',
    finish: 'Finalizar',
    state: {
      prepared:
        'Firmado. Esperando la entrega de su mensaje; sus fondos están retenidos.',
      delivered: 'Mensaje entregado. El pago está en camino a la cadena.',
      failed:
        'Su mensaje no se pudo entregar. El pago se conserva; sus fondos están retenidos.',
    },
  },
  chatMessageStealth: {
    outboundState: {
      unknown: 'Sin comprobar',
      planned: 'Preparando',
      prepared: 'Pendiente',
      delivered: 'Pendiente',
      paid: 'Pagado',
      failed: 'Falló la entrega de la transferencia',
      released: 'Cancelado antes del envío',
    },
    title: 'Pago privado',
    sentTitle: 'Pago privado enviado',
    receivedTitle: 'Pago privado recibido',
    viewInExplorer: 'Ver transacción en el explorador de bloques',
    viewTransaction: 'Ver transacción',
    sent: 'Enviado',
    pending: 'Pendiente',
    received: 'Recibido',
    unverified: 'Sin comprobar',
    pendingHint:
      'Esperando a que la cadena muestre este pago. Aún no está en tu saldo.',
    spendableHint: 'Incluido en tu saldo disponible para gastar',
    spentHint: 'Recibido y gastado posteriormente',
    unverifiedHint: 'Tu cartera no ha comprobado este pago en la cadena.',
    statedAmount: 'Quien envía indicó {stated}; la cadena muestra {actual}.',
    notReceived: 'Pago no recibido',
    notReceivedHint:
      'Quien envía afirmó haber hecho este pago, pero la cadena no muestra esa transferencia. No está en tu saldo. Tu cartera sigue comprobándolo.',
    failed: 'El pago falló',
    failedHint:
      'Este pago nunca puede llegar: su transacción falló o fue reemplazada. No está en tu saldo.',
    claimedAmount: 'importe declarado',
    notReceivedNotice: 'Un pago declarado por quien envía ({amount}) no llegó.',
  },
  setup: {
    loginOrSignUp: 'Iniciar sesión / Registrarse',
    welcome: 'Bienvenido',
    welcomeToStampChat: '¡Bienvenido a Frank!',
    networkTitle: 'Monad Testnet',
    testnetDisclaimer:
      'Frank funciona en la red de prueba de Monad. Todas las transacciones usan MON de prueba, que no tiene valor monetario real. Nunca envíes fondos reales ni activos de la red principal.',
    economicModelTitle: 'Acciones de pago y costes',
    costsDisclaimer:
      'Las acciones salientes tienen costes de red y de sello. La comisión real o el importe del sello siempre se muestran antes de confirmar una acción.',
    directMessagesTitle: 'Mensajes directos',
    directMessagesDesc:
      'Se pagan directamente al destinatario como un sello de buzón, evitando el spam y remunerando la entrega.',
    topicActionsTitle: 'Publicaciones y votos del foro',
    topicActionsDesc:
      'Se queman (se destruyen permanentemente en cadena) para publicar en temas públicos o registrar votos.',
    fundingTitle: 'Fondos de prueba',
    fundingDesc:
      'Las cuentas nuevas reciben MON de prueba automáticamente del grifo de demostración. También puedes ver tu dirección y obtener fondos de prueba desde la pantalla Recibir después de configurar la cuenta.',
    eulaDisclaimer:
      'Frank es software experimental. Puede contener errores que retrasen mensajes o causen pérdidas de fondos. Usa solo importes que puedas permitirte perder.',
    eulaYouUnderstand:
      'Al hacer clic en "Aceptar", reconoces que Frank se proporciona "tal cual", sin garantías de ningún tipo, expresas ni implícitas.',
    setupWallet: 'Configuración del personaje',
    eula: 'Acuerdo de licencia de usuario final',
    deposit: 'Depositar Lotus',
    settings: 'Configuración',
    back: 'Volver',
    seedWarning:
      'Anota tu frase de recuperación y guárdala en un lugar seguro. Si la pierdes, nadie podrá recuperar tu cuenta.',
    searchingRelay:
      'Buscando datos existentes en el servidor de retransmisión...',
    networkErrorRelayDied:
      'Error de red: se perdió la conexión con el servidor de retransmisión. ',
    networkErrorRelayUnexpected:
      'Error de red: el servidor de retransmisión falló inesperadamente.',
    requestingPayment: 'Solicitando pago...',
    sendingPayment: 'Enviando pago...',
    uploadingMetaData: 'Subiendo metadatos...',
    openingInbox: 'Abriendo buzón...',
    profileImageLargeError:
      'La imagen de perfil es demasiado grande; selecciona una más pequeña.',
    continue: 'Continuar',
    finish: 'Finalizar',
    generatingWallet: 'Generando cartera...',
    gatheringBalances: 'Recopilando saldos...',
    watchingWallet: 'Supervisando cartera...',
    searchingExistingMetaData: 'Buscando metadatos de registro existentes...',
    errorContactRegistry: 'No se puede contactar con el registro',
    storedSeedMismatch:
      'No se puede reemplazar la frase de recuperación de este dispositivo desde esta pantalla.',
    replaceNotAcknowledged:
      'No se puede reemplazar esta cuenta sin confirmar el reemplazo.',
    accountSetupNext: 'Siguiente',
    depositStepNext: 'Siguiente',
  },
  accountStep: {
    newAccount: 'Nueva cuenta',
    importAccount: 'Importar cuenta',
    copyRecoveryPhrase: 'Copiar frase de recuperación',
    refreshRecoveryPhrase: 'Generar una frase de recuperación nueva',
    resumeNotice:
      'Este dispositivo ya tiene una frase de recuperación guardada, pero la cuenta aún no tiene nombre. Confírmala y elige un nombre para terminar. No se reemplaza salvo que importes otra frase que ya tengas.',
    confirmStoredFirst:
      'Confirma o copia primero tu frase de recuperación guardada.',
    importDifferentPhrase: 'Ya tengo otra frase de recuperación',
    importDifferentContinue: 'Continuar para importar',
    invalidWordCount:
      'Una frase de recuperación debe contener 12, 15, 18, 21 o 24 palabras.',
    unrecognizedWords:
      'No se reconocen una o más palabras. Comprueba si hay errores de escritura.',
    invalidChecksum:
      'La suma de comprobación de la frase de recuperación no es válida. Revisa el orden y la ortografía de las palabras.',
  },
  seedConfirm: {
    unavailable:
      'La confirmación no está disponible porque este dispositivo no tiene un generador seguro de números aleatorios. Vuelve atrás y reintenta, o usa otro navegador.',
    stepTitle: 'Confirmar frase',
    title: 'Confirma tu frase de recuperación',
    instructions:
      'Introduce las palabras solicitadas de la frase de recuperación que anotaste. Tu cuenta solo se crea cuando coinciden.',
    wordLabel: 'Palabra #{n}',
    check: 'Comprobar mis respuestas',
    wordError: 'La palabra #{n} no coincide',
    recheck:
      'Algunas palabras no coinciden con tu frase de recuperación. Revisa estos números de palabra: {positions}.',
    success:
      'Frase de recuperación confirmada. Puedes finalizar la configuración.',
    showPhrase: 'Mostrar de nuevo mi frase de recuperación',
    hidePhrase: 'Ocultar mi frase de recuperación',
    phraseLabel: 'Tu frase de recuperación, en orden',
  },
  backupReminder: {
    regionLabel:
      'Recordatorio de copia de seguridad de la frase de recuperación',
    message:
      'Aún no has confirmado tu frase de recuperación. Confirma que la guardaste para poder recuperar siempre tu cuenta.',
    confirm: 'Confirmar ahora',
    dismiss: 'Más tarde',
  },
  replaceGuard: {
    title: 'Ya tienes una cuenta en este dispositivo',
    intro:
      'Configurarla de nuevo la reemplazaría. Tu frase de recuperación es la única forma de recuperar esta cuenta y sus fondos.',
    introNameOnly:
      'Configurarla de nuevo lo reemplazaría. Este perfil no tiene frase de recuperación ni fondos de cartera en este dispositivo.',
    confirmed: 'Tu frase de recuperación actual está confirmada.',
    cancel: 'Cancelar y volver a mi cuenta',
    confirmCurrent: 'Confirmar mi frase de recuperación actual',
    replaceToggle: 'Reemplazar esta cuenta',
    warning:
      'Reemplazar esta cuenta eliminará tu frase de recuperación, nombre y perfil actuales de este dispositivo. Si no guardaste una copia de la frase, la cuenta y sus fondos podrían ser irrecuperables.',
    warningNameOnly:
      'Reemplazar esta cuenta eliminará tu nombre y perfil actuales de este dispositivo.',
    typeLabel: 'Escribe {word} para continuar',
    word: 'REPLACE',
    mismatch: 'No coincide. Escribe la palabra exactamente para continuar.',
    replace: 'Reemplazar esta cuenta',
  },
  newContactDialog: {
    lookup: {
      'clock':
        'La fecha y hora de este dispositivo parecen incorrectas, por lo que no se pudo comprobar esta dirección. Revisa el reloj y reintenta.',
      'not-published':
        'Esta dirección aún no se ha publicado, por lo que no puede recibir mensajes. Pide a su propietario que abra la aplicación una vez.',
      'unreachable':
        'No se puede acceder al servidor para consultar esta dirección. Reintenta en un momento.',
      'refused':
        'El servidor devolvió una entrada para esta dirección que no está firmada por ella, ha caducado o entra en conflicto con una vista antes. No se utilizó.',
      'messaging-off':
        'Tu propia cuenta aún se está publicando. Podrás añadir contactos cuando se active la mensajería.',
    },
    newContact: 'Nuevo contacto',
    startConversation: 'Iniciar conversación',
    startConversationBtn: 'Iniciar conversación',
    addContact: 'Añadir contacto',
    addAndChat: 'Añadir y chatear',
    contactAdded: 'Contacto añadido',
    composeEmail: 'Redactar correo',
    enterBitcoinCashAddress:
      'Introduce una dirección (0x...) o dirección de correo',
    enterAddress: 'Introduce una dirección (0x...) o dirección de correo',
    enterAddressOrEmail:
      'Introduce una dirección (0x...), nombre de contacto, nombre de usuario o correo',
    existingContacts: 'Contactos existentes',
    existingContact: 'Contacto existente',
    clearContact: 'Quitar contacto',
    topicOptional: 'Asunto (opcional)',
    topicPlaceholder: 'p. ej., planificación de proyecto, consulta, factura',
    loading: 'Buscando contacto',
    notFound: 'No encontrado',
    found: 'Contacto encontrado: {name}',
    ownAddress:
      'Esta es tu propia dirección. No puedes añadirte como contacto.',
    showMyQr: 'Mostrar mi código QR',
    startEmail: 'Iniciar correo',
    startEmailThread:
      'Iniciar hilo de correo a {email} (mediante Frank Email Gateway)',
    startEmailThreadAffordance:
      'Iniciar hilo de correo a {email} (mediante Frank Email Gateway)',
    sendEmailViaGateway:
      'Redactar y enviar correo saliente mediante Frank Email Gateway',
  },
  emailThread: {
    gatewayBadge: '✉️ Puente de correo (mediante Frank Gateway)',
    unverifiedBadge: '⚠️ Correo P2P directo (sin verificar)',
    collapseAll: 'Contraer todo',
    expandAll: 'Expandir todo',
    participants: 'Participantes',
    messageSingle: 'mensaje',
    messagePlural: 'mensajes',
    to: 'Para',
    cc: 'Cc',
    bcc: 'Cco',
    attachmentsCount: 'Adjuntos ({count}):',
    attachFiles: 'Adjuntar archivos',
    reply: 'Responder',
    replyAll: 'Responder a todos',
    replySender: 'Responder al remitente',
    hideCc: '- CC',
    showCc: '+ CC',
    hideBcc: '- CCO',
    showBcc: '+ CCO',
    addRecipient: 'Añadir destinatario...',
    addCcRecipient: 'Añadir destinatario en Cc...',
    addBccRecipient: 'Añadir destinatario en Cco...',
    subjectLabel: 'Asunto:',
    subjectPlaceholder: 'Asunto',
    writeMessagePlaceholder: 'Escribe tu mensaje de correo...',
    writeReplyPlaceholder: 'Escribe tu respuesta por correo...',
    quoteOriginal: 'Citar original',
    preview: 'Vista previa',
    edit: 'Editar',
    send: 'Enviar',
    sendTooltip: 'Enviar mediante Frank Email Gateway (Ctrl+Enter)',
    newDraftTitle: 'Nuevo hilo de correo',
    newDraftSubtitle:
      'Redacta tu mensaje abajo. Frank lo entregará a través de Frank Email Gateway al destinatario mediante el correo electrónico estándar de Internet.',
    newEmail: 'Nuevo correo saliente',
    followUp: 'Borrador de seguimiento',
    stampExplanation:
      'Entregado mediante Frank Email Gateway. El sello paga el envío de la pasarela y la prueba contra el spam.',
    formatBold: 'Negrita',
    formatItalic: 'Cursiva',
    formatHeading: 'Encabezado',
    formatQuote: 'Cita',
    formatCode: 'Código',
    formatBullet: 'Lista con viñetas',
    formatLink: 'Enlace',
    showQuotedText: 'Mostrar texto citado',
    hideQuotedText: 'Ocultar texto citado',
  },
  newTopicDialog: {
    newTopic: 'Añadir tema',
    enterTopic: 'Introduce un tema...',
    topicNameMinLength: 'Usa al menos 3 caracteres',
    topicNameRules: 'Solo se permiten A-Z, a-z, 0-9 y puntos',
    add: 'Añadir',
    cancel: 'Cancelar',
  },
  topicDrawer: {
    offering: 'Ofreciendo:',
    filter: 'Filtro:',
  },
  SettingPanel: {
    newContact: 'Nuevo contacto',
    contacts: 'Contactos',
    sendMonad: 'Enviar MON',
    receiveMonad: 'Recibir MON',
    profile: 'Perfil',
    settings: 'Configuración',
    changeLog: 'Registro de cambios',
    showSeed: 'Mostrar semilla',
    confirmSeed: 'Confirmar frase de recuperación',
    panelLabel: 'Configuración',
  },
  receiveBitcoinDialog: {
    walletStatus: 'Estado de la cartera',
    balanceUnavailable: 'Saldo no disponible. Reintentando.',
    noFundsHint:
      'Tu saldo es 0. Esta aplicación usa MON de prueba, que no tiene valor real. El grifo de demostración financia automáticamente los perfiles nuevos; si no llega nada en un minuto, pide al operador de la demostración que envíe MON de prueba a la dirección de abajo.',
    close: 'Cerrar',
    addressCopied: 'Dirección copiada al portapapeles',
    failedLoadBalance: 'No se pudo cargar el saldo de la cartera',
    unableCopyAddress: 'No se puede copiar la dirección de Monad',
  },
  walletHistory: {
    transfers: 'Transferencias',
    to: 'Para',
    contract: 'Contrato',
    details: 'Detalles',
    intended:
      'Este es el importe solicitado. El pago completo aún no está confirmado.',
    dateUnknown: 'No se registró la fecha de esta transferencia.',
    transaction: 'Transacción {number}',
    status: {
      confirmed: 'Confirmada',
      included: 'Enviada',
      reverted: 'Revertida',
      partial: 'Procesada parcialmente',
      pending: 'Pendiente',
      missing: 'Esperando a la red',
      unknown: 'Comprobando pago',
      cancelled: 'Cancelada',
    },
    memberStatus: {
      'included-success': 'Confirmada',
      'included-revert': 'Revertida',
      'pending': 'Pendiente',
      'missing': 'Aún no está en la red',
      'unknown': 'Sin confirmar',
    },
  },
  nativeOperation: {
    title: 'Resultado de la transferencia',
    listTitle: 'Transferencias nativas',
    intendedAmount: 'Importe previsto para el destinatario',
    processing: 'Comprobando el resultado de la transferencia original…',
    included: 'Enviada en {network}.',
    reverted:
      'La transacción al destinatario se revirtió en {network}. Es posible que se hayan pagado comisiones de red.',
    partial:
      'Algunas transacciones de financiación están incluidas en {network}; el pago al destinatario no figura como incluido.',
    pending: 'En la mempool de {network}: enviada, esperando un bloque.',
    missing:
      '{network} aún no tiene esta transferencia. Se está ofreciendo de nuevo.',
    watching:
      'Supervisando la red. Se actualiza automáticamente cuando la transferencia entra en un bloque.',
    unknown:
      'El resultado del pago no se ha resuelto en {network}. Es posible que se hayan movido fondos.',
    cancelled: 'Transferencia sin firmar cancelada.',
    feecomplete: 'Comisiones de red observadas: {amount} {unit}',
    feepartial:
      'Comisiones observadas hasta ahora (parciales): {amount} {unit}',
    feeunknown: 'Comisiones de red observadas no disponibles.',
    block: 'Bloque {block}',
    syncNotShared: 'Aún no se ha compartido con tus otros dispositivos.',
    syncShared: 'Enviado a tus otros dispositivos.',
    syncFailed:
      'Aún no se pudo enviar a tus otros dispositivos. Se reintentará; tu pago no se ve afectado.',
    recoveryUnavailable: 'La recuperación no está disponible en este momento.',
    reviewHeld: 'Esta revisión no puede enviar otro pago.',
    unsupported:
      'El historial de transferencias nativas no está disponible para esta cartera.',
    unavailable: 'Las pruebas de la transferencia nativa no están disponibles.',
    empty: 'No hay transferencias nativas conservadas.',
    viewTransfer: 'Ver transferencia',
    contractCall: 'Llamada a contrato (un intercambio o su aprobación)',
    back: 'Volver',
    stale:
      'La cuenta o la página ha cambiado. Consulta la transferencia original desde su cartera.',
  },
  sendAddressDialog: {
    sendToAddress: 'Enviar a una dirección',
    enterBitcoinCashAddress: 'Introduce una dirección (0x...)',
    enterAmount: 'Introduce el importe ({unit})',
    cancel: 'Cancelar',
    send: 'Enviar',
    review: 'Revisar',
    reviewTitle: 'Revisar transferencia',
    network: 'Red',
    recipient: 'Destinatario',
    amount: 'Importe',
    estimatedFee: 'Comisión estimada',
    feeUnavailable: 'No disponible',
    refused: 'La red rechazó esta transacción. No se envió nada.',
    feeChanged:
      'La comisión de red aumentó. No se envió nada. Revisa la nueva comisión y confirma de nuevo.',
    maxTotal: 'Importe + comisión de red',
    maxTotalWithFee: '{amount} {unit} (+ comisión de red)',
    irreversibleWarning:
      'Las transacciones de la cadena de bloques son irreversibles. Verifica el destinatario y la red antes de confirmar.',
    editTransfer: 'Editar',
    confirmAndSend: 'Confirmar y enviar',
    definitelyNotBroadcast:
      'La transacción no se difundió. No se transfirieron fondos.',
    potentiallyBroadcast:
      'La transacción se firmó ({txHash}) y puede haberse difundido. Comprueba tu saldo o el estado de la transacción antes de reintentar.',
    invalidTransfer:
      'Introduce una dirección válida de Monad y un importe en MON.',
    failedSendTransaction: 'No se pudo enviar la transacción de Monad',
  },
  sendContactDialog: {
    available: 'Disponible para este pago: {amount}',
    title: 'Enviar a un contacto',
    selectContact: 'Seleccionar contacto',
    searchContacts: 'Buscar contactos...',
    selectedContact: 'Contacto seleccionado',
    changeContact: 'Cambiar',
    noContactsFound: 'No se encontraron contactos',
    enterAmount: 'Introduce el importe ({unit})',
    amount: 'Importe',
    memo: 'Nota (opcional)',
    reviewTransfer: 'Revisar transferencia',
    recipient: 'Destinatario',
    stealthNotice:
      'Se paga a una dirección de un solo uso desde la que solo este contacto puede gastar. Un mensaje indica a su cartera dónde está el dinero.',
    confirmAndSend: 'Confirmar y enviar',
    sending: 'Enviando...',
    cancel: 'Cancelar',
    back: 'Volver',
    edit: 'Editar',
    invalidAmount: 'Introduce un importe válido',
    missingSpendKey:
      'El contacto no tiene una clave pública registrada para pagos privados',
    sent: 'Pago enviado',
    pending:
      'Pago guardado. Su mensaje sigue en proceso de entrega; se paga cuando llega el mensaje. No lo envíes de nuevo.',
    notSent: 'No se pudo realizar el pago. No se envió nada.',
    messageEnded:
      'El pago está guardado y su mensaje no se pudo entregar. Abre el chat con este contacto y reintenta el mensaje: no se ha pagado nada y nada se paga dos veces.',
    tooLarge:
      'Este pago supera lo que puede incluir un solo pago a un contacto (unos {max} {unit}); envíalo por partes.',
  },
  contactBookDialog: {
    contacts: 'Contactos',
    search: 'Buscar...',
    close: 'Cerrar',
    myQrCode: 'Mi código QR de identidad',
  },
  contactItem: {
    address: 'Dirección',
    inboxPrice: 'Precio del buzón',
    notFound: 'No encontrado',
  },
  settings: {
    title: 'Configuración',
    back: 'Volver',
    openMenu: 'Abrir el menú',
    appearance: 'Apariencia',
    networking: 'Conectividad',
    contactRefreshInterval: 'Intervalo de actualización de contactos (minutos)',
    contactRefreshIntervalHint:
      'Intervalo entre actualizaciones de contactos (minutos)',
    darkMode: 'Modo oscuro',
    themeTitle: 'Piedra del tema Signet',
    saveSettings: 'Guardar',
    savedNotification: 'Configuración guardada',
    cancelSettings: 'Cancelar',
    languageSelectorCaption: 'Idioma',
    networkSettings: 'Configuración de red y pasarela',
    emailGatewayAddress: 'Dirección de la pasarela de correo',
    emailGatewayFee:
      'Comisión de sello del correo entrante: 0.01 MONT. La pasarela paga el envío y la verificación contra el spam.',
    emailGatewayRelayLabel: 'Pasarela del servidor de retransmisión:',
    emailGatewayChanged:
      'El servidor de retransmisión o la identidad de su pasarela de correo ha cambiado. Revisa la nueva dirección antes de usarla.',
    emailGatewayChecking:
      'Comprobando si este servidor de retransmisión tiene una pasarela de correo…',
    emailGatewayUnavailable:
      'Este servidor de retransmisión no tiene una pasarela de correo disponible. No se pueden enviar correos salvo que establezcas una dirección explícita.',
    emailGatewayOverrideHint:
      'Dirección alternativa opcional para la red seleccionada',
    acceptRelayGateway: 'Aceptar pasarela del servidor de retransmisión',
    useRelayGateway: 'Usar pasarela del servidor de retransmisión',
    resetDefault: 'Restablecer valor predeterminado',
    save: 'Guardar',
    gateways: 'Pasarelas',
    networkModeTitle: 'Entorno de red y cadenas',
    testnetMode: 'Modo de red de prueba',
    testnetActiveBanner:
      'La red de prueba está activa en Monad y en todas las redes secundarias de liquidación.',
    mainnetActiveBanner:
      'La red principal está activa. Las transacciones y liquidaciones usan activos reales.',
    mainnetLockedBanner:
      'Por ahora, el cambio a la red principal está bloqueado.',
    supportedChainsTitle: 'Redes de liquidación compatibles',
    chainSendReceive: 'Enviar y recibir',
    chainUnsupported: 'No compatible',
    notificationFeeThresholdAvu: 'Umbral de comisión para notificaciones (AVU)',
    notificationFeeThresholdAvuHint:
      'Valor mínimo del sello en AVU (1 AVU = 1 kWh, p. ej., 0.01 AVU) necesario para activar una notificación push (los mensajes por debajo de este umbral se entregan igualmente en tu buzón sin notificación)',
    allowContactNotificationBypass:
      'Permitir que los contactos con tokens de activación notifiquen sin sello',
    coldVaultTitle: 'Bóveda de transferencia automática a cartera fría',
    coldVaultSubtitle:
      'Transfiere automáticamente los sellos y pagos entrantes que superen el límite de tu cartera en línea directamente (1 salto) a una dirección de bóveda externa de MetaMask, Phantom o Ledger.',
    coldVaultEnabled: 'Activar transferencia automática a cartera fría',
    coldVaultAddressLabel: 'Dirección de bóveda externa (EVM / Solana)',
    coldVaultAddressHint:
      'Dirección de cartera física o del navegador (0x... o Solana base58) que recibe los fondos excedentes',
    coldVaultMaxHotBalanceLabel:
      'Límite máximo de saldo de la cartera en línea (MON)',
    coldVaultMaxHotBalanceHint:
      'Predeterminado: 1,500 MON (~150 AVU, activación por histéresis de +20% en 1,800 MON)',
    languageAutomatic: 'Automático (idioma del navegador)',
  },
  profile: {
    name: 'Nombre visible',
    seedEntry: 'Frase de recuperación',
    importSeed: 'Recuperar recuerdos anteriores',
    invalidSeed: 'Esa no es una frase de recuperación válida.',
    nameHint: 'Nombre que se muestra a otras personas',
    enterSeed: 'Introduce tu frase de recuperación...',
    nameBlank:
      'Introduce un nombre: no puede estar vacío ni contener solo espacios.',
    nameTooLong:
      'El nombre es demasiado largo: usa como máximo {max} caracteres.',
    nameForbiddenCharacters:
      'El nombre contiene caracteres no permitidos. Quita los saltos de línea y otros caracteres de control.',
    nameInvalidUnicode:
      'El nombre contiene un carácter no válido. Elimínalo o pega texto sin formato.',
    bio: 'Biografía',
    bioHint: 'Biografía breve que se muestra a otras personas',
    uploadAvatar: 'Subir avatar',
    username: 'Nombre de usuario',
    usernameHint:
      'Identificador único (3–32 caracteres, letras minúsculas, números, guiones y guiones bajos)',
    invalidUsername:
      'El nombre de usuario debe tener 3–32 caracteres y contener solo letras minúsculas, números, guiones y guiones bajos.',
    usernameTaken: 'Ese nombre de usuario ya está ocupado. Elige otro.',
    usernameNotPublished:
      'Tu cuenta aún no está publicada en el servidor de retransmisión. Espera a que se active la mensajería y vuelve a guardar.',
    usernameUnavailable:
      'No se pudo establecer el nombre de usuario: no se pudo acceder al servidor de retransmisión o este rechazó la solicitud. Reintenta.',
    usernameConfirmedTitle:
      'Nombre de usuario confirmado por el servidor de retransmisión',
    usernameNoWallet:
      'Desbloquea tu cuenta antes de establecer un nombre de usuario: la solicitud debe estar firmada por ella.',
    usernameNotHeld:
      'El nombre de usuario guardado no pertenece a esta cuenta en el servidor de retransmisión. Abre tu perfil para ver el motivo.',
    usernameStillHeld:
      'Esta cuenta posee {username}. No se puede renunciar a un nombre de usuario: sigue siendo tuyo hasta que reclames otro.',
    nameStartsWithAt:
      "Un nombre no puede empezar por {'@'}. Establece tu nombre de usuario en el campo Nombre de usuario.",
    location: 'Ubicación',
    locationHint: 'Dónde te encuentras (opcional)',
    links: 'Enlaces y redes sociales',
    addLink: 'Añadir enlace',
    removeLink: 'Quitar enlace',
    linkType: 'Plataforma / Tipo',
    linkUrl: 'URL o identificador',
    linkLabel: 'Etiqueta (opcional)',
    linkTypeWebsite: 'Sitio web / Blog',
    linkTypeX: 'X (Twitter)',
    linkTypeGithub: 'GitHub',
    linkTypeNostr: 'Nostr',
    linkTypeTelegram: 'Telegram',
    linkTypeDiscord: 'Discord',
    linkTypeOther: 'Otro',
    unnamed: 'Sin nombre',
    accountType: 'Tipo de cuenta',
    accountTypeHint:
      'Indica si esta cuenta representa a una persona, bot, servicio u organización',
    accountTypePerson: 'Persona',
    accountTypeBot: 'Bot',
    accountTypeService: 'Servicio',
    accountTypeOrganization: 'Organización',
    botRole: 'Función del bot / servicio',
    botRoleHint: 'Función especializada de esta cuenta automatizada',
    botRoleGeneric: 'Genérica',
    botRoleAssistant: 'Asistente de IA',
    botRoleFaucet: 'Grifo',
    botRoleGame: 'Árbitro / Crupier de juego',
    botRoleBridge: 'Puente',
    botRoleMerchant: 'Comerciante / Tienda',
    botRoleModerator: 'Moderador',
    botRoleAnnouncer: 'Anunciante',
    badgeOfficial: 'Oficial',
    badgeOfficialBot: 'Bot oficial',
    badgeOfficialService: 'Servicio oficial',
    badgeBot: 'Bot',
    badgeService: 'Servicio',
    badgeAi: 'IA oficial',
    badgeFaucet: 'Grifo oficial',
    badgeGame: 'Juego',
    badgeOfficialGame: 'Juego oficial',
    badgeMerchant: 'Comerciante',
    badgeOfficialMerchant: 'Comerciante oficial',
    badgeModerator: 'Moderador',
    badgeOfficialModerator: 'Moderador oficial',
    badgeAnnouncer: 'Anunciante',
    badgeOfficialAnnouncer: 'Anunciante oficial',
    badgeBridge: 'Puente',
    badgeOfficialBridge: 'Puente oficial',
  },
  clearHistoryDialog: {
    cancel: 'Cancelar',
    clear: 'Borrar',
    message: '¿Confirmas que quieres borrar todo el historial de chat con',
  },
  deleteContactDialog: {
    message: '¿Eliminar a {name} y todas las conversaciones con este contacto?',
    cancel: 'Cancelar',
    delete: 'Eliminar contacto y conversaciones',
    failed: 'No se pudo terminar de eliminar este contacto. Reintenta.',
  },
  deleteChatDialog: {
    cancel: 'Cancelar',
    delete: 'Eliminar',
    message: '¿Confirmas que quieres eliminar todo el historial de chat con',
  },
  deleteMessageDialog: {
    cancel: 'Cancelar',
    delete: 'Eliminar',
    message: '¿Confirmas que quieres eliminar este mensaje?',
  },
  imageDialog: {
    close: 'Cerrar',
  },
  profileDialog: {
    accountChanged:
      'Tu cuenta ha cambiado. Vuelve a abrir el perfil antes de guardar.',
    cancel: 'Cancelar',
    update: 'Actualizar',
    republish: 'Volver a publicar',
    avatarTooLarge:
      'El avatar del perfil es demasiado grande; selecciona una imagen más pequeña.',
    unableContactRelay:
      'No se puede contactar con el servidor de retransmisión.',
    pushingProfile: 'Publicando perfil nuevo...',
    profile: 'Perfil',
    savedNotification: 'Perfil actualizado',
    identityQr: 'Identidad y QR',
    viewIdentityQr: 'Compartir / QR para amigos',
    identityHeading: 'Tu identidad de Frank',
    identitySubheading:
      'Comparte este código QR o dirección con tus amigos para que puedan añadirte a sus contactos y enviar mensajes cifrados.',
    identityAddressLabel:
      'Dirección de identidad (para mensajería y contactos)',
    identityExplanation:
      'Esta dirección canónica se publica en el servidor de retransmisión del directorio. Tus amigos añaden esta dirección para iniciar chats directos cifrados de extremo a extremo contigo.',
    receiveVsIdentityTitle: 'Dirección de identidad y dirección de recepción',
    receiveVsIdentityBody:
      'Tu dirección de identidad se usa para contactos, mensajería y el perfil del foro. Para recibir fondos, tokens o gas, usa tu dirección de recepción.',
    receiveAddressHint:
      '¿Necesitas recibir monedas o tokens? Tu dirección de recepción se gestiona en tu cartera.',
    goToWallet: 'Ir a la cartera',
    scanPrompt: 'Escanea para añadir como contacto en Frank',
  },
  seedPhraseDialog: {
    seedPhrase: 'Frase de recuperación',
    close: 'Cerrar',
    cancel: 'Cancelar',
    warningTitle: 'Advertencia de seguridad',
    warningBody:
      'Asegúrate de que nadie esté mirando tu pantalla. Ten cuidado al compartir pantalla, con personas que miren por encima de tu hombro, las capturas de pantalla y el historial del portapapeles.',
    disclosureText:
      'Cualquiera que obtenga tu frase de recuperación puede acceder y robar todos tus fondos y mensajes de forma permanente.',
    revealButton: 'Revelar frase de recuperación',
    hideButton: 'Ocultar',
    copyButton: 'Copiar',
    copied: '¡Copiado!',
    copiedToast: 'Frase de recuperación copiada al portapapeles',
    keepPrivateNotice:
      'Mantén esto privado. No lo compartas ni hagas capturas de pantalla.',
  },
  transactionDialog: {
    stealthPayment: 'Pago privado',
    valueUnavailable: 'Valor de la transacción no disponible',
    transactionUnavailable: 'No se pudo decodificar la transacción',
    baseUnits: 'unidades base',
    stampState: {
      pending: 'Enviado',
      mempool: 'En la mempool',
      paid: 'Pagado',
      repaid: 'Pagado de nuevo',
      reverted: 'Revertido',
      failed: 'Fallido',
      unsent: 'No pagado',
    },
    backingTransactions: 'Transacciones de respaldo',
    totalStampPayment: 'Pago total del sello',
    stampPaymentN: 'Pago de sello {n}',
    sentTo: 'Para {address}',
    txId: 'ID de transacción',
    txType: 'Tipo',
    txAddress: 'Dirección',
    txAmount: 'Importe',
    copyTxHash: 'Copiar hash de transacción',
    localChainNotice: 'Entorno local / adaptador de cadena',
    txHashCopied: 'Hash de transacción copiado al portapapeles',
  },
  about: {
    appName: 'Frank',
    title: 'Acerca de',
    menu: 'Acerca de y licencias',
    tagline: 'Mensajería privada para Monad con resistencia económica al spam.',
    checkForUpdates: 'Buscar actualización',
    checkingForUpdates: 'Buscando actualizaciones…',
    alreadyLatestVersion: 'Tienes la versión más reciente.',
    reloadAndClearCache: 'Recargar y borrar caché',
    clearCacheConfirm: '¿Confirmas que quieres borrar la caché y recargar?',
    frankTitle: 'Acerca de Frank',
    frankIntro:
      'Frank es un criptomensajero descentralizado y soberano diseñado para la cadena de bloques Monad, que continúa y desarrolla el protocolo Stamp. Combina identidades criptográficas sin permiso con resistencia económica real al spam.',
    frankAccounts:
      'Las cuentas son pares de claves secp256k1 sin permiso generados íntegramente en tu dispositivo. Frank no requiere números de teléfono, direcciones de correo ni proveedores centrales de cuentas.',
    stampTitle: 'El protocolo Stamp: la libertad de expresión tiene un coste',
    stampIntro:
      'En lugar de depender de intermediarios centralizados o de vigilancia para filtrar el spam, el protocolo Stamp introduce incentivos económicos directos en la comunicación.',
    stampDMsTitle: 'Mensajes directos y entrega de pago',
    stampDMsDesc:
      'Cada mensaje directo incluye una transacción de sello en cadena que paga directamente al destinatario mediante destinos privados derivados de un solo uso. Quien envía paga por tu atención, eliminando por completo el spam no solicitado.',
    stampTopicsTitle: 'Publicaciones en temas y ponderación por quema',
    stampTopicsDesc:
      'Las publicaciones en temas públicos y los votos de la comunidad queman MON en una dirección desde la que no se puede gastar, dando un peso económico demostrable al discurso público sin moderación central.',
    stampPrivacyTitle: 'Cifrado de extremo a extremo',
    stampPrivacyDesc:
      'Todo el contenido de los mensajes se cifra de extremo a extremo. Los servidores federados CashWeb validan las transacciones de sello y almacenan sobres sin ver nunca el contenido en texto claro.',
    badgeMonad: 'Monad',
    badgeStamp: 'Stamp Protocol',
    badgeEncrypted: 'Cifrado de extremo a extremo',
    badgePermissionless: 'Identidad sin permiso',
    thirdPartyTitle: 'Software de terceros',
    dklsName:
      'Biblioteca DKLs23 de firma entre dos partes (Silence Laboratories)',
    dklsModified:
      'Frank incluye una versión modificada de la biblioteca DKLs23 de Silence Laboratories. El proyecto Frank la modificó el {date}, de forma independiente y sin participación alguna de Silence Laboratories.',
    dklsChanges:
      'Cambios realizados: una sesión de firma queda vinculada a un mensaje y se añadió la prefirma con adaptador entre dos partes.',
    dklsNonCommercial:
      'Este componente solo se puede usar con fines no comerciales. La licencia MIT del propio Frank no se aplica a él.',
    dklsSource:
      'El código fuente de la biblioteca modificada está en el repositorio de Frank, en la carpeta {path}.',
    licenseHeading: 'Licencia de la biblioteca DKLs23',
    licenseIntro:
      'El texto completo de la licencia, incluidas sus condiciones y exención de responsabilidad, tal como lo publicó Silence Laboratories (solo en inglés):',
  },
  swap: {
    interfaceFee: 'Comisión de Frank ({rate})',
    venueNote:
      'Despliegue de prueba operado por {maintainer}, no por Uniswap Labs',
    pay: 'Pagas',
    payToken: 'Token con el que pagas',
    receive: 'Recibes',
    receiveToken: 'Token que recibes',
    switchTokens: 'Intercambiar los dos tokens',
    available: 'Disponible',
    balance: 'Saldo',
    max: 'MÁX',
    otherAccounts: '{amount} más en otras cuentas de esta cartera',
    testToken: 'token de prueba',
    reviewMove:
      'Primero se trasladarán {amount} {unit} desde tus otras cuentas a tu cuenta principal, que realiza el intercambio.',
    reviewStale:
      'No se pudo actualizar el precio. Reintentando; podrás confirmar cuando esté actualizado.',
    progressRecovering: 'Finalizando una transacción anterior de esta cartera…',
    rate: 'Tasa',
    priceImpact: 'Impacto en el precio',
    poolFee: 'Comisión del fondo de liquidez',
    minimumReceived: 'Mínimo recibido',
    networkFee: 'Comisión de red',
    networkFeeKnown: '{fee} {unit}',
    networkFeePartial:
      '{fee} {unit} por las aprobaciones; la comisión del propio intercambio se conocerá cuando se confirmen',
    reviewPaySame:
      'Pagas {amount} {asset} + {fee} {unit} de comisión de red = {total} {unit}.',
    reviewPayOther: 'Pagas {amount} {asset} + {fee} {unit} de comisión de red.',
    reviewPayPartial:
      'Pagas {amount} {asset} + {fee} {unit} de comisión de red por las aprobaciones, más la comisión de red del propio intercambio, que se mostrará cuando se confirmen.',
    reviewPayNoFee:
      'Pagas {amount} {asset}, más una comisión de red que aún no se pudo estimar.',
    reviewReceive:
      'Recibes aproximadamente {receive} {asset}. Si fueras a recibir menos de {minimum} {asset}, se cancela el intercambio y conservas el activo con el que ibas a pagar.',
    resultPaidSame:
      'Pagaste {amount} {asset} + {fee} {unit} de comisión de red = {total} {unit}.',
    resultPaidOther:
      'Pagaste {amount} {asset} + {fee} {unit} de comisión de red.',
    resultPaidFeeOnly: 'Pagaste {fee} {unit} en comisiones de red y nada más.',
    warnFeeLarger: 'La comisión de red supera el importe que intercambias.',
    warnFeeShare:
      'La comisión de red es aproximadamente el {percent}% del importe que intercambias.',
    networkFeeLater: 'se estima tras la aprobación',
    approval: 'Aprobación',
    approvalNeeded:
      'Primero {count} transacción(es) de aprobación, por exactamente este importe de {asset}',
    slippage: 'Tolerancia al deslizamiento',
    slippageCustom: 'Deslizamiento personalizado, en porcentaje',
    enterAmount: 'Introduce un importe',
    review: 'Revisar intercambio',
    reviewTitle: 'Confirmar este intercambio',
    reviewNote:
      'El precio se comprueba de nuevo al confirmar. El intercambio caduca {seconds} segundos después de firmarse.',
    back: 'Volver',
    confirm: 'Confirmar intercambio',
    newSwap: 'Nuevo intercambio',
    progressConsolidating: 'Trasladando fondos a la cuenta del intercambio…',
    progressApproving: 'Aprobando el importe exacto ({step} de {of})…',
    progressSigning: 'Preparando y enviando el intercambio…',
    progressSubmitted: 'Enviado. Esperando la confirmación de la red…',
    progressKeepOpen:
      'Puedes salir de esta página: el intercambio queda registrado y aparece en Intercambios recientes.',
    resultConfirmed: 'Intercambio completado',
    resultConfirmedDetail:
      'Recibido en tu cartera, según el registro en cadena.',
    resultConfirmedUnknown:
      'El intercambio se confirmó. No se pudo leer el importe recibido en el recibo; tu saldo de abajo está actualizado.',
    resultReverted: 'Intercambio no completado',
    resultRevertedSlippage:
      'El precio superó tu tolerancia al deslizamiento, por lo que se canceló el intercambio. Conservaste tus fondos y solo pagaste la comisión de red.',
    resultRevertedDeadline:
      'El intercambio llegó a la red después de caducar, por lo que se canceló. Conservaste tus fondos y solo pagaste la comisión de red.',
    resultRevertedOther:
      'La red rechazó el intercambio. Conservaste tus fondos y solo pagaste la comisión de red.',
    resultPending: 'Enviado, aún sin confirmar',
    resultPendingDetail:
      'La red aún no ha confirmado este intercambio. Todavía puede completarse; su estado se actualiza en Intercambios recientes. No lo envíes de nuevo.',
    unavailableNetwork:
      'No hay intercambios disponibles para esta cartera en esta red.',
    unavailableSolana:
      'Los intercambios de esta cartera Solana aún no están disponibles.',
    unavailableWallet:
      'Esta cartera aún no puede intercambiar. Ábrela y reintenta.',
    unavailableError:
      'No se pudo cargar el intercambio. Comprueba tu conexión.',
    errorSameAsset: 'Elige dos tokens diferentes.',
    errorInsufficientBalance: 'No hay suficiente {asset}',
    errorInsufficientForFee:
      'No hay suficiente {asset} para este importe más la comisión de red',
    errorInsufficientNative:
      'No hay suficiente moneda de la red para pagar este intercambio y su comisión.',
    errorNoRoute: 'Estos dos tokens no se pueden intercambiar aquí.',
    errorNoLiquidity:
      'El fondo de liquidez no puede cubrir este importe. Prueba con uno menor.',
    errorPriceMoved:
      'El precio superó tu tolerancia al deslizamiento. Revisa el nuevo importe.',
    errorExpired: 'El intercambio caducó antes de enviarse. Revísalo de nuevo.',
    errorAllowance:
      'La aprobación de este importe falta o ha caducado. Reintenta.',
    errorAccountBusy:
      'Una transacción anterior de esta cartera aún no se ha confirmado. Reintenta en un momento.',
    errorApprovalFailed:
      'La aprobación no se confirmó, por lo que no se intercambió nada. Reintenta.',
    errorAccountChanged:
      'La cuenta ha cambiado. Revisa el intercambio de nuevo.',
    errorQuote: 'No se pudo obtener un precio de la red. Reintenta.',
    failureDiagnostic: 'Detalles del fallo: {stage} · {code}',
    errorExecution:
      'No se pudo confirmar el estado del intercambio. Consulta Intercambios recientes antes de reintentar; un intercambio enviado aún puede completarse.',
    warnHighImpact:
      'Este importe es grande para el fondo de liquidez: recibes bastante menos que a la tasa de mercado.',
    status: {
      confirmed: 'Confirmado',
      pending: 'Pendiente',
      failed: 'No completado',
    },
  },
  solanaSwap: {
    route: 'Ruta',
    enterAmount: 'Introduce un importe para intercambiar',
    loading: 'Cargando tus tokens de Solana…',
    unsupportedTitle: 'Los intercambios no están disponibles en esta red',
    unsupportedBody:
      'No hay ningún mercado activado para esta red Solana, por lo que aquí no se pueden obtener cotizaciones ni realizar intercambios.',
    loadError: 'No se pudieron cargar tus tokens de Solana.',
    pendingUnreadable:
      'No se puede leer en este dispositivo el registro guardado de un intercambio en curso, por lo que no se sabe si sigue pendiente. No se puede iniciar ningún intercambio nuevo aquí hasta resolverlo.',
    retry: 'Volver a intentar',
    venueTestnet:
      'Operando en {venue}, {network}: tokens de prueba sin valor real.',
    venueMainnet:
      'Operando en {venue}, {network}. Este intercambio usa fondos reales.',
    payToken: 'Token que pagas',
    receiveToken: 'Token que recibes',
    flip: 'Intercambiar los dos tokens',
    slippage: 'Tolerancia al deslizamiento',
    invalidAmount: 'Introduce un importe con un máximo de {decimals} decimales',
    rate: 'Tasa',
    priceImpact: 'Impacto en el precio',
    minimumReceived: 'Como mínimo',
    tradeFee: 'Comisión del fondo de liquidez (incluida en la tasa)',
    networkFee: 'Comisión de red',
    priorityFee: 'Comisión de prioridad',
    priorityFeeHint:
      'La establece la transacción para incluirse antes; se cobra íntegra si se procesa el intercambio',
    accountRent: 'Depósito para abrir tu cuenta de {token}',
    accountRentHint:
      'Se paga una vez. Permanece en tu propia cuenta y se devuelve si la cierras.',
    temporaryRent: 'Retenido durante el intercambio',
    temporaryRentHint:
      'Necesario en tu cartera mientras se realiza el intercambio; la misma transacción lo devuelve.',
    platformFee: 'Comisión de Frank ({percent}%)',
    platformFeeFromInput: 'Parte de lo que pagas.',
    platformFeeFromOutput: 'Ya descontada de lo que recibes.',
    totalLeaving: 'Total que sale de tu cartera',
    noPlatformFee: 'Frank no añade ninguna comisión a este intercambio.',
    reviewSwap: 'Revisar intercambio',
    reviewTitle: 'Revisar este intercambio',
    reviewWhereTestnet:
      'En {venue}, en {network}. Son tokens de prueba sin valor real.',
    reviewWhereMainnet: 'En {venue}, en {network}. Esto usa fondos reales.',
    netLine:
      'En total: salen {give} de tu cartera y llegan aproximadamente {get} (nunca menos de {minimum}; de lo contrario, el intercambio no se realiza).',
    costWarning:
      'Las comisiones y depósitos ({costs}) representan el {percent}% del importe intercambiado ({amount}).',
    back: 'Volver',
    confirmSwap: 'Confirmar intercambio',
    refreshQuote: 'Obtener cotización actual',
    paid: 'Pagas',
    expected: 'Recibes aproximadamente',
    actuallyPaid: 'Pagaste',
    networkFeeCharged: 'Comisión de red cobrada',
    priorityFeeCharged: 'Comisión de prioridad cobrada',
    totalLeft: 'Total que salió de tu cartera',
    received: 'Recibiste',
    checkAgain: 'Comprobar de nuevo',
    newSwap: 'Nuevo intercambio',
    stage: {
      signing: 'Firmando…',
      submitted: 'Enviado. Esperando la confirmación de la red…',
      confirmed: 'Intercambio completado',
      failed: 'El intercambio falló',
      expired: 'El intercambio no se procesó',
      unknown: 'Seguimos comprobando este intercambio',
    },
    stageNote: {
      signing:
        'Tu cartera está firmando el intercambio. Aún no se ha enviado nada.',
      submitted:
        'Esto suele tardar unos segundos. Puedes salir de esta página; el intercambio queda registrado y se sigue supervisando.',
      confirmed:
        'Estas cifras provienen de la transacción confirmada, no de la cotización.',
      failed:
        'La red rechazó el intercambio, por lo que no se intercambió nada. Solo se pagó la comisión de red.',
      expired:
        'La red no incluyó el intercambio antes de caducar. No se intercambió nada ni se pagó ninguna comisión. Puedes reintentar.',
      unknown:
        'No se pudo acceder a la red, por lo que aún no se sabe si este intercambio se realizó. No se ha enviado otra vez como un intercambio nuevo.',
    },
    error: {
      invalidRequest:
        'No se puede cotizar este intercambio. El importe puede ser demasiado pequeño o los tokens iguales.',
      noRoute: 'Aquí no hay mercado para este par.',
      insufficientBalance:
        'No tienes suficiente cantidad del token con el que pagas.',
      insufficientSol:
        'No hay suficiente SOL para cubrir este intercambio, su comisión de red y sus depósitos.',
      slippage:
        'El precio superó tu tolerancia al deslizamiento. Obtén una nueva cotización o aumenta la tolerancia.',
      simulationFailed:
        'La red rechazaría este intercambio, por lo que no se envió.',
      venueUnavailable: 'El mercado no respondió. Reintenta en unos segundos.',
      unsafeTransaction:
        'La transacción de este intercambio haría algo distinto del intercambio cotizado, por lo que no se firmó.',
      unexpected: 'Algo salió mal y no se envió el intercambio.',
    },
  },
  calendarInvite: {
    allDay: 'Todo el día',
    organizer: 'Organizador',
    location: 'Ubicación',
    statusConfirmed: 'Confirmado',
    statusTentative: 'Provisional',
    statusCancelled: 'Cancelado',
    rsvpTally:
      '{accepted} Aceptados · {tentative} Provisionales · {declined} Rechazados',
    accept: 'Aceptar',
    tentative: 'Provisional',
    decline: 'Rechazar',
    addToOsCalendar: 'Añadir al calendario de Apple / del sistema (.ics)',
    addToGoogleCalendar: 'Google Calendar',
    attachCalendarOrContact: 'Adjuntar calendario (.ics) o contacto (.vcf)',
    invalidFile: 'No se pudo leer {name}: {reason}',
  },
  contactCard: {
    title: 'Tarjeta de contacto',
    frankAddress: 'Dirección de Frank',
    email: 'Correo electrónico',
    phone: 'Teléfono',
    website: 'Sitio web',
    addToContacts: 'Añadir a los contactos de Frank',
    addedToContacts: 'Añadido a los contactos de Frank',
    saveVcf: 'Guardar vCard (.vcf)',
  },
  onboard: {
    toolbarTitle: 'Primeros pasos en Frank',
    headerBadge: 'Inicio con autocustodia y cifrado de extremo a extremo',
    heading: 'Continúa tu conversación en Frank',
    keysGeneratedPrefix: 'Tus claves privadas se generan',
    keysGeneratedHighlight: '100% localmente en tu navegador',
    keysGeneratedSuffix: 'y nunca se comparten con la pasarela de correo.',
    threadImportPrefix: 'Tu hilo de correo con',
    threadImportSuffix: 'se importará automáticamente.',
    subjectLabel: 'Asunto:',
    bridgedEmailLabel: 'Correo mediante puente:',
    signedInAs: 'Sesión iniciada como',
    localFrankAccount: 'Cuenta local de Frank',
    importThreadAndOpenChat: 'Importar hilo y abrir chat con la otra persona',
    displayNameLabel: 'Nombre visible',
    displayNameHint: 'Se muestra a tus contactos cuando les escribes en Frank',
    createAccountAndOpenChat: 'Crear cuenta de autocustodia y abrir chat',
    continueWithPasskey: 'Continuar con clave de acceso (Mera)',
  },
  close: 'Cerrar',
  signedSwap: {
    actions: {
      offer: 'Oferta',
      accept: 'Aceptación',
      reject: 'Rechazo',
    },
    title: 'Intercambio',
    negotiationOnly:
      'Solo negociación firmada. Aceptar no transfiere ni autoriza fondos.',
    offerAmount: 'Ofrecer {unit} en {network}',
    requestAmount: 'Solicitar {unit} en {network}',
    expiry: 'Caducidad ({timezone})',
    review: 'Revisar',
    propose: 'Firmar y proponer',
    newOffer: 'Nueva oferta',
    accept: 'Aceptar',
    reject: 'Rechazar',
    confirmResponse: 'Firmar {decision}',
    stamp: 'Sello del mensaje',
    baseUnits: 'unidades base',
    history: 'Historial de negociación autenticado',
    pending: 'Autorizaciones guardadas',
    resume: 'Reanudar autorización original',
    selectExpiry: 'Selecciona una fecha y hora de caducidad.',
    delivery: 'Entrega del mensaje',
    error: 'No se pudo finalizar la negociación',
    legacy: 'Historial de intercambios sin firmar no compatible',
    phases: {
      claimed: 'Firma sin finalizar',
      signed: 'Firma guardada',
    },
    deliveryStates: {
      'confirmed': 'Entregado',
      'pending': 'Entrega pendiente',
      'payment-pending': 'Pago del sello pendiente',
      'error': 'Entrega sin finalizar',
    },
    errors: {
      capacity:
        'Se alcanzó la capacidad de almacenamiento. Las autorizaciones guardadas se conservan.',
      expired:
        'Selecciona una caducidad futura para una autorización nueva. Los mensajes firmados conservan su caducidad original.',
      conflict: 'Este espacio de firma ya identifica otra autorización.',
      invalidAmount:
        'Introduce un importe decimal positivo y exacto dentro de la precisión nativa y los límites del protocolo.',
      invalidIntent:
        'La autorización guardada no es válida. Se ha conservado para su inspección.',
      sessionChanged:
        'La cuenta, red o conversación autenticada ha cambiado. Revisa de nuevo.',
      storage:
        'El almacenamiento no está disponible. La autorización no se ha descartado.',
      deliveryPending:
        'La firma está guardada y la entrega de su mensaje original no ha finalizado. Reanúdala.',
      failed:
        'No se pudo finalizar la negociación. Su autorización guardada se conserva.',
    },
    states: {
      'restoring': 'Restaurando pruebas de negociación',
      'scanning': 'Comprobando mensajes autenticados',
      'ready': 'Listo',
      'unsupported':
        'La negociación de intercambios no está disponible en esta red',
      'incomplete': 'Las pruebas autenticadas están incompletas',
      'capacity': 'Se alcanzó la capacidad de almacenamiento de negociaciones',
      'storage-error': 'Falló el almacenamiento de la negociación',
      'awaitingAdmission':
        'El evento firmado está pendiente de admisión autenticada',
      'conflict': 'Pruebas de negociación contradictorias',
      'expired': 'Negociación caducada',
      'offered': 'Oferta autenticada',
      'accept': 'Aceptación autenticada; no se han transferido fondos',
      'reject': 'Rechazo autenticado',
    },
  },
}
