// This is just an example,
// so you can safely delete all default props below

export default {
  agree: "D'accord",
  chat: {
    donationMessage:
      "Merci de participer à notre vision du futur des communications. Merci de considérer contribuer en envoyant une donation en BCH à l'adresse suivante : bitcoincash:qq7vt04md0pt6fk5szhcx4cgsfuzmppy5u4hxshr4a",
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
  },
  leftDrawer: {
    settings: 'Paramètres',
    contacts: 'Contacts',
    forum: 'Forum',
    railLabel: 'Sections de la barre latérale',
    contactsUnreadOne: 'Contacts, {count} message non lu',
    contactsUnreadOther: 'Contacts, {count} messages non lus',
  },
  chatList: {
    noContactMessage: 'Add contacts from the drawer above...', //----
    balance: 'Crédit',
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
    changeLog: 'Changelog',
    showSeed: 'Montrer la phrase de passe',
    confirmSeed: 'Confirmer la phrase de récupération',
  },
  receiveBitcoinDialog: {
    walletStatus: 'Etat du wallet',
    balanceUnavailable: 'Solde indisponible. Nouvelle tentative.',
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
    pleaseType: "Soyez plus créatif, s'il vous plait",
    bio: 'Biographie',
    bioHint: 'Courte biographie telle que vue par vos correspondants',
    uploadAvatar: 'Télécharger un avatar',
  },
  clearHistoryDialog: {
    cancel: 'Annuler',
    clear: 'Clear',
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

  profileDialog: {
    cancel: 'Annuler',
    update: 'Mettre à jour',
    avatarTooLarge:
      "L'image de votre avatar est trop volumineuse, choisissez en une plus petite.",
    unableContactRelay: 'Impossible de contacter le serveur-relai.',
    pushingProfile: 'Envoi du nouveau profil..',
    invalidName:
      'Saisissez un nom public : 1 à 128 caractères, sans caractères de contrôle.',
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
    seedPhrase: 'Phrase de passe',
  },
  transactionDialog: {
    backingTransactions: 'Transactions',
    txId: 'Transaction ID',
    txType: 'Type',
    txAddress: 'Adresse',
    txAmount: 'Montant',
  },
  close: 'Fermer',
}
