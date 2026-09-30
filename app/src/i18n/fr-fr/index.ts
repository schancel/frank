// This is just an example,
// so you can safely delete all default props below

export default {
  forum: {
    noPosts: 'Aucun message pour le moment.',
  },
  agree: "D'accord",
  chat: {
    stampPreparationChecking: 'Vérification des comptes de timbre privés…',
    stampPreparationFunding:
      'Préparation des comptes de timbre privés ({completed}/{total} transactions on-chain ; jusqu’à {feeReserve} {unit} de réserve de frais chacune)…',
    stampPreparationReady: 'Comptes de timbre privés prêts ; envoi du message…',
    donationMessage:
      "Merci de participer à notre vision du futur des communications. Merci de considérer contribuer en envoyant une donation en BCH à l'adresse suivante : bitcoincash:qq7vt04md0pt6fk5szhcx4cgsfuzmppy5u4hxshr4a",
  },
  stampPreparation: {
    posting: 'Publication en cours…',
    postCreated: 'Message publié !',
    postedRefreshFailed:
      'Votre message a été publié, mais l’actualisation a échoué. Rechargez pour le voir. Ne le publiez pas à nouveau.',
    votedRefreshFailed:
      'Votre vote a été envoyé, mais l’actualisation a échoué. Rechargez pour le voir. Ne votez pas à nouveau.',
  },
  chatLayout: {
    info: 'Infos',
    infoTitle: 'Infos',
    mute: 'Muet',
    unmute: 'Réactiver le son',
    selectMessages: 'Sélectionner des messages',
    selectMessagesTitle: 'Sélectionner des messages',
  },
  chatInput: {
    giveLotusSecretly: 'Donner des lotus secrêtement',
    attachImage: 'Attacher une image',
    placeHolder: 'Ecrire un message...',
    emojiPickerTitle: 'Choisir un emoji',
    stampPrice: 'Prix du timbre',
    stampPayment: 'Paiement du timbre',
    stampQuickSelection: 'Sélection rapide de 1× à 100× le timbre par défaut',
    stampMultiplierValue: '{multiplier}× le défaut',
  },
  digitalGoods: {
    catalog: 'Catalogue',
    buy: 'Acheter',
    priceUnavailable: 'prix indisponible',
    hiddenOne: '{count} autre article non affiché',
    hiddenMany: '{count} autres articles non affichés',
    requested: 'Demandé : {itemId}',
    fulfilled: 'Voici votre achat ({itemId}) :',
  },
  chatImage: {
    notShown: 'Image non affichée ({reason})',
    reasonNotAnImage: "ce n'est pas une image",
    reasonTooLarge: 'trop volumineuse',
    reasonNotInline: 'pas une image intégrée',
    reasonUnreadableHeader: "en-tête d'image illisible",
    reasonEmpty: 'image vide',
    reasonDimensionsTooLarge: 'dimensions trop grandes',
  },
  raffleDraw: {
    verified: "Le tirage correspond à l'engagement de la graine",
    failed: 'Échec de la vérification : {reason}',
    explainerToggle: 'Que montre ceci ?',
    explainerShows:
      "Montre : l'opérateur n'a pas changé la graine après s'y être engagé, et le gagnant découle des participants listés et de cette graine.",
    explainerNotShown:
      "Ne montre pas : que les participants listés sont de vrais paiements on-chain, ni qu'aucune participation n'a été écartée.",
    explainerCountUnverified:
      "Le tirage n'a pas annoncé sa taille : le nombre de participants n'est pas vérifié.",
  },
  persistentStorage: {
    tab: 'Stockage',
    heading: 'Stockage persistant',
    granted: 'Stockage persistant : accordé',
    notGranted: 'Stockage persistant : non accordé',
    unsupported: 'Stockage persistant : non pris en charge par ce navigateur',
    unknown: 'Stockage persistant : vérification…',
    explainGranted:
      'Votre navigateur a accepté de conserver les données de cette application sauf si vous les effacez vous-même. Votre phrase de récupération reste la seule sauvegarde si vous perdez cet appareil.',
    explainNotGranted:
      'Votre navigateur peut supprimer les données de cette application, dont votre phrase de récupération enregistrée, lorsqu’il manque d’espace ou, dans Safari, après 7 jours sans visite sauf si l’application est ajoutée à l’écran d’accueil. Votre phrase de récupération est la seule sauvegarde.',
    explainUnsupported:
      'Ce navigateur ne peut pas être invité à conserver les données de cette application et peut donc les supprimer (Safari le fait après 7 jours sans visite sauf si l’application est ajoutée à l’écran d’accueil). Votre phrase de récupération est la seule sauvegarde.',
    request: 'Demander au navigateur de conserver mes données',
    confirmSeed: 'Confirmer ma phrase de récupération',
    seedConfirmed: 'Votre phrase de récupération est confirmée.',
  },
  blackjackBet: {
    menuLabel: 'Jouer au blackjack',
    title: 'Commencer une main de blackjack',
    amountLabel: 'Montant de la mise',
    amountAria: 'Montant de la mise en MON',
    limits: 'Limites de la table : {min} à {max} MON',
    notice:
      'Votre mise est un vrai transfert de MON vers {name} ({address}). À utiliser uniquement avec un croupier de blackjack.',
    confirm:
      'Je comprends que {amount} MON seront envoyés à {name} ({address})',
    confirmRequired: 'Cochez la case pour confirmer le transfert.',
    submit: 'Distribuez-moi avec {name} {address} ({amount} MON)',
    sending: 'Envoi de votre mise…',
    sent: 'Mise envoyée. En attente de la distribution.',
    notDelivered:
      'Mise payée, pari non livré : {message} Utilisez Réessayer dans la conversation pour renvoyer le pari.',
    errorFormat: 'Saisissez la mise sous forme de nombre décimal simple',
    errorInvalid: 'Saisissez un montant valide en MON',
    errorZero: 'La mise doit être supérieure à zéro',
    errorMin: 'La mise est inférieure au minimum de la table ({min} MON)',
    errorMax: 'La mise dépasse le maximum de la table ({max} MON)',
    errorBalanceUnknown:
      "Votre solde n'est pas encore chargé. Réessayez dans un instant.",
    errorBalance:
      'Solde insuffisant : ce pari nécessite {needed} MON (la mise plus environ {rest} MON pour le timbre du message et les frais), vous avez {balance} MON.',
    errorUnsent:
      "Terminez la mise non envoyée dans la conversation avant d'en commencer une autre.",
    errorFunds: 'Fonds insuffisants : {message}',
    errorSend: 'Impossible de placer la mise : {message}',
    unsentTitle: 'Mise payée, pari non livré',
    unsentBody:
      "Votre mise de {amount} MON vers {name} ({address}) a été payée, mais le message de pari n'est pas parvenu au croupier.",
    unsentTx: 'Transaction : {hash}',
    unsentRetry: "Réessayer d'envoyer le pari",
    unsentRetrying: 'Envoi du pari…',
    unsentFailed: 'Toujours pas livré : {message}',
    confirming:
      'En attente de la confirmation de votre paiement par le réseau…',
    errorPaymentFailed:
      "La transaction de paiement a échoué sur le réseau : aucune mise n'a été placée.",
    paymentPending:
      'Votre paiement est encore en cours de confirmation. Il est conservé dans la conversation ; utilisez Vérifier le paiement.',
    paymentUnknown:
      "Le réseau n'a pas encore vu votre paiement. Il peut encore arriver : il est conservé dans la conversation ; utilisez Vérifier le paiement. Ne supposez pas que rien n'a été payé.",
    unsentSigned: 'Paiement non confirmé',
    unsentSignedBody:
      "Une mise de {amount} MON vers {name} ({address}) a été envoyée, mais le réseau ne l'a pas encore confirmée.",
    unsentDealerSilent: 'En attente du croupier',
    unsentDealerSilentBody:
      "Votre pari de {amount} MON vers {name} ({address}) a été livré, mais le croupier n'a pas répondu.",
    unsentDealerUnconfirmed:
      "Le croupier n'a pas encore pu vérifier votre paiement",
    checkPayment: 'Vérifier le paiement',
    checking: 'Vérification auprès du réseau…',
    paymentStillPending: 'Le paiement est toujours en attente sur le réseau.',
    paymentNotFound:
      "Le réseau ne connaît pas (encore) ce paiement. Si vous êtes certain qu'il n'a jamais été envoyé, vous pouvez supprimer cet enregistrement.",
    paymentFailedRemoved:
      "La transaction de paiement a échoué sur le réseau ; rien n'a été payé. L'enregistrement a été supprimé.",
    dismiss: 'Supprimer cet enregistrement',
    dismissWarning:
      "Si cette mise a réellement été payée, supprimer l'enregistrement peut faire perdre l'argent. Ne le faites que si vous êtes sûr qu'elle n'a pas été payée ou a été remboursée.",
    dismissConfirm: 'Oui, le supprimer',
    dismissCancel: 'Le garder',
    loadError:
      'Les enregistrements de mises sauvegardés sont illisibles : {message}',
  },
  leftDrawer: {
    noForums: 'Aucun forum découvert pour le moment.',
    settings: 'Paramètres',
    contacts: 'Contacts',
    forum: 'Forum',
    railLabel: 'Sections de la barre latérale',
    contactsUnreadOne: 'Contacts, {count} message non lu',
    contactsUnreadOther: 'Contacts, {count} messages non lus',
  },
  chatList: {
    noContactMessage: 'Ajoutez des contacts depuis le tiroir ci-dessus...',
    youPrefix: 'Vous : {text}',
    themPrefix: 'Contact : {text}',
    balance: 'Solde',
    balanceStale: '(dernière valeur connue)',
    directMessages: 'Messages privés',
  },
  mailboxStatus: {
    unavailable:
      'Service de messagerie indisponible : ce relais ne propose pas la messagerie, vous ne recevrez donc pas de messages.',
    unreachable:
      'Impossible de joindre le serveur. Vous ne recevez peut-être pas de messages ; nouvelle tentative en cours.',
    rateLimited:
      'Le serveur nous a demandé de ralentir. Nouvelle tentative sous peu.',
    unauthorized:
      'Le serveur a refusé votre connexion à la messagerie. Nouvelle tentative en cours.',
  },
  chatMessage: {
    noPayloadFound: 'Impossible de trouver les données pour ce message',
    failedToSend: 'Échec de l’envoi',
    showActions: 'Afficher les actions du message',
    replyMessage: 'Répondre au message',
    forwardMessage: 'Transférer le message',
    infoMessage: 'Informations sur le message',
    deleteMessage: 'Supprimer le message',
  },
  chatRightDrawer: {
    stampPrice: 'Prix du timbre',
    sendLotus: 'Envoyer des Lotus',
    notifications: 'Notifications',
    clearHistory: 'Effacer l’historique',
    deleteChat: 'Supprimer la discussion',
    unknownContact: 'Inconnu',
  },
  sendLotusDialog: {
    sendLotusTo: 'Envoyer des Lotus à',
    amountHint: 'Combien de Lotus voulez vous transmettre.',
    amountPlaceholder: 'Entrez le nombre de Lotus...',
    memoHint: 'Ajouter un mémo au paiement.',
    memoPlaceholder: 'Entrez le texte...',
    sendBtnLabel: 'Envoyer',
    cancelBtnLabel: 'Annuler',
  },
  sendFileDialog: {
    sendFile: 'Envoyer un fichier',
    captionHint: 'Attacher un memo au fichier.',
    captionPlaceholder: 'Entrez le texte...',
    sendBtnLabel: 'Envoyer',
    cancelBtnLabel: 'Annuler',
  },
  topicDrawer: {
    offering: 'Offre:',
    filter: 'Filtrer:',
  },
  setup: {
    loginOrSignUp: 'Connexion/Inscription',
    welcome: 'Bienvenue',
    welcomeToStampChat: 'Bienvenue sur Frank !',
    eulaDisclaimer:
      'Frank est un logiciel expérimental. Il peut contenir des erreurs susceptibles de retarder des messages ou d’entraîner une perte de fonds. N’utilisez que des montants que vous pouvez vous permettre de perdre.',
    eulaYouUnderstand:
      'En cliquant sur « Accepter », vous reconnaissez que Frank est fourni « tel quel », sans garantie d’aucune sorte, expresse ou implicite.',
    setupWallet: 'Setup de votre compte', //---- 'Character Setup'
    eula: 'Contrat de licence',
    deposit: 'Deposer des Lotus',
    settings: 'Paramètres',
    back: 'Retour',
    seedWarning:
      'Ne perdez jamais votre phrase de passe car vous ne seriez plus en mesure de récupérer ce compte.',
    searchingRelay: 'Recherche des relais...',
    networkErrorRelayDied: 'Erreur réseau: Le serveur relais ne réponds plus.',
    networkErrorRelayUnexpected:
      'Erreur réseau: Le serveur a généré une erreur inattendue.',
    requestingPayment: 'En attente de paiement...', //?
    sendingPayment: 'Envoi du paiement...',
    uploadingMetaData: 'Téléchargement des metadonnées...',
    openingInbox: 'Ouverture de la boite de réception...',
    profileImageLargeError:
      "L'image de votre avatar est trop volumineuse, choisissez en une plus petite.",
    continue: 'Continuer',
    finish: 'Finir',
    generatingWallet: 'Generation de votre wallet...',
    gatheringBalances: 'Récupération du solde...',
    watchingWallet: 'Surveillance du wallet...', //?
    searchingExistingMetaData: 'Recherche des métadonnées dans le registre...',
    errorContactRegistry: 'Impossible de se connecter au registre',
    storedSeedMismatch:
      'La phrase de récupération de cet appareil ne peut pas être remplacée depuis cet écran.',
    replaceNotAcknowledged:
      'Ce compte ne peut pas être remplacé sans confirmer le remplacement.',
    accountSetupNext: 'Suivant',
    depositStepNext: 'Suivant',
  },
  accountStep: {
    newAccount: 'Nouveau compte',
    importAccount: 'Importer un compte',
    copyRecoveryPhrase: 'Copier la phrase de récupération',
    refreshRecoveryPhrase: 'Générer une nouvelle phrase de récupération',
    resumeNotice:
      'Une phrase de récupération est déjà enregistrée sur cet appareil, mais ce compte n’a pas encore de nom. Votre phrase ne sera pas modifiée. Confirmez-la et choisissez un nom pour terminer.',
  },
  seedConfirm: {
    unavailable:
      'La confirmation est indisponible car cet appareil n’a pas de générateur de nombres aléatoires sécurisé. Revenez en arrière et réessayez, ou utilisez un autre navigateur.',
    stepTitle: 'Confirmer la phrase',
    title: 'Confirmez votre phrase de récupération',
    instructions:
      'Saisissez les mots demandés de la phrase de récupération que vous avez notée. Votre compte n’est créé que lorsqu’ils correspondent.',
    wordLabel: 'Mot n° {n}',
    check: 'Vérifier mes réponses',
    error:
      'Un ou plusieurs mots ne correspondent pas à votre phrase de récupération. Vérifiez votre copie et réessayez.',
    success:
      'Phrase de récupération confirmée. Vous pouvez terminer la configuration.',
    showPhrase: 'Afficher à nouveau ma phrase de récupération',
    hidePhrase: 'Masquer ma phrase de récupération',
    phraseLabel: 'Votre phrase de récupération, dans l’ordre',
  },
  backupReminder: {
    regionLabel: 'Rappel de sauvegarde de la phrase de récupération',
    message:
      'Vous n’avez pas encore confirmé votre phrase de récupération. Confirmez que vous l’avez sauvegardée pour toujours pouvoir récupérer votre compte.',
    confirm: 'Confirmer maintenant',
    dismiss: 'Plus tard',
  },
  replaceGuard: {
    title: 'Vous avez déjà un compte sur cet appareil',
    intro:
      'Recommencer la configuration le remplacerait. Votre phrase de récupération est le seul moyen de récupérer ce compte et ses fonds.',
    confirmed: 'Votre phrase de récupération actuelle est confirmée.',
    cancel: 'Annuler et revenir à mon compte',
    confirmCurrent: 'Confirmer ma phrase de récupération actuelle',
    replaceToggle: 'Remplacer ce compte',
    warning:
      'Remplacer ce compte supprimera de cet appareil votre phrase de récupération, votre nom et votre profil actuels. Si vous n’avez pas sauvegardé la phrase, le compte et ses fonds pourraient être irrécupérables.',
    typeLabel: 'Saisissez {word} pour continuer',
    word: 'REMPLACER',
    mismatch:
      'Cela ne correspond pas. Saisissez exactement le mot pour continuer.',
    replace: 'Remplacer ce compte',
  },
  newContactDialog: {
    newContact: 'Nouveau contact',
    enterBitcoinCashAddress: 'Entrez une adresse Lotus...',
    loading: 'Recherche du contact',
    notFound: 'Non trouvé',
    found: 'Contact trouvé : {name}',
    ownAddress:
      "Il s'agit de votre propre adresse. Vous ne pouvez pas vous ajouter comme contact.",
  },
  newTopicDialog: {
    newTopic: 'Créer un nouveau topic',
    enterTopic: 'Entrez le nom du topic...',
    topicNameMinLength: 'Minimum 3 caractères',
    topicNameRules:
      'Seuls sont autorisés les caractères alphanumériques et les points',
    add: 'Ajouter',
    cancel: 'Annuler',
  },
  SettingPanel: {
    newContact: 'Nouveau contact',
    contacts: 'Contacts',
    sendMonad: 'Envoyer des MON',
    receiveMonad: 'Recevoir des MON',
    profile: 'Profil',
    settings: 'Configuration',
    wipeAndSave: 'Consolidation du portefeuille',
    changeLog: 'Journal des modifications',
    showSeed: 'Montrer la phrase de passe',
    confirmSeed: 'Confirmer la phrase de récupération',
    panelLabel: 'Paramètres',
  },
  receiveBitcoinDialog: {
    close: 'Fermer',
    walletStatus: 'Etat du wallet',
    balanceUnavailable: 'Solde indisponible. Nouvelle tentative.',
    noFundsHint:
      "Votre solde est de 0. Cette application utilise des MON de testnet, sans valeur réelle. Le faucet de démonstration alimente automatiquement les nouveaux profils ; si rien n'arrive après une minute, demandez à l'opérateur de la démo d'envoyer des MON de testnet à l'adresse ci-dessous.",
    addressCopied: 'Adresse copiée dans le presse papier',
  },
  sendAddressDialog: {
    sendToAddress: "Envoyer vers l'adresse",
    enterBitcoinCashAddress: "Saisissez l'adresse de destination...",
    enterAmount: 'Saisissez le montant (MON)',
    cancel: 'Annuler',
    send: 'Envoyer',
  },
  contactBookDialog: {
    close: 'Fermer',
    contacts: 'Contacts',
    search: 'Recherche...',
  },
  contactItem: {
    address: 'Adresse',
    inboxPrice: 'Prix du timbre', //?Inbox Price
    notFound: 'Non trouvé',
  },
  settings: {
    appearance: 'Apparence',
    networking: 'Réseau',
    contactRefreshInterval:
      'Fréquence de rafraîchissement des contacts (minutes)',
    contactRefreshIntervalHint:
      'Intervalle entre mise à jour des contacts (minutes)', //? Interval between contact updates (minutes)
    darkMode: 'Mode Nuit/Sombre',
    saveSettings: 'Enregistrer',
    cancelSettings: 'Annuler',
    languageSelectorCaption: 'Langue',
  },
  profile: {
    name: 'Pseudonyme',
    seedEntry: 'Phrase de passe',
    importSeed: 'Rappel des mémoires perdues', //? Recover past memories
    invalidSeed: 'Phrase de passe invalide...',
    nameHint: 'Identifiant tel que vu par vos correspondants',
    enterSeed: 'Entrez votre phrase de passe...',
    nameBlank:
      'Saisissez un nom : il ne peut pas être vide ni ne contenir que des espaces.',
    nameTooLong: 'Le nom est trop long : {max} caractères au maximum.',
    nameForbiddenCharacters:
      'Le nom contient des caractères non autorisés. Supprimez les retours à la ligne et autres caractères de contrôle.',
    nameInvalidUnicode:
      'Le nom contient un caractère invalide. Supprimez-le ou collez du texte brut.',
    bio: 'Biographie',
    bioHint: 'Courte biographie telle que vue par vos correspondants',
    uploadAvatar: 'Télécharger un avatar',
  },
  clearHistoryDialog: {
    cancel: 'Annuler',
    clear: 'Effacer',
    message:
      "Êtes-vous sûr de vouloir effacer tout l'historique des discussions avec",
  },
  deleteChatDialog: {
    cancel: 'Annuler',
    delete: 'Effacer',
    message:
      "Êtes-vous sûr de vouloir effacer tout l'historique des discussions avec",
  },
  deleteMessageDialog: {
    cancel: 'Annuler',
    delete: 'Effacer',
    message: 'Etes vous sûr de vouloir effacer ce message ?',
  },

  imageDialog: {
    close: 'Fermer',
  },
  profileDialog: {
    cancel: 'Annuler',
    update: 'Mettre à jour',
    avatarTooLarge:
      "L'image de votre avatar est trop volumineuse, choisissez en une plus petite.",
    unableContactRelay: 'Impossible de contacter le serveur-relai.',
    pushingProfile: 'Envoi du nouveau profil..',
    profile: 'Profil',
  },
  wipeWallet: {
    warning: 'ATTENTION!',
    warningMsg:
      'Cette opération va effacer tous les messages du serveur et consolider les fonds associés dans votre wallet (celui dont vous avez la phrase de passe)',
    cannotBeUndone: 'Cette opération ne peut pas être annulée !',
    cancel: 'Annuler',
    wipe: 'Effacer tout le contenu distant', //?Wipe All Remote Content
    spinnerText: 'Effacer tous les messages',
  },
  seedPhraseDialog: {
    close: 'Fermer',
    seedPhrase: 'Phrase de passe',
  },
  transactionDialog: {
    backingTransactions: 'Transactions',
    totalStampPayment: 'Paiement total du timbre',
    stampPaymentN: 'Paiement du timbre {n}',
    sentTo: 'À {address}',
    txId: 'ID de la transaction',
    txType: 'Type',
    txAddress: 'Adresse',
    txAmount: 'Montant',
  },
  close: 'Fermer',
}
