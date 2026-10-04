// This is just an example,
// so you can safely delete all default props below

import { fr as accountRecovery } from '../account-recovery'

export default {
  directoryProvisioning: {
    title: 'Installation de l’annuaire',
    pending: 'Installation par l’opérateur en attente',
    checking: 'Vérification de la configuration installée…',
    ready:
      'Prêt : installation de démonstration locale vérifiée. La messagerie chiffrée est activée.',
    explanation:
      'Les deux relais et le bot doivent disposer du même ensemble approuvé de comptes publics. L’admission récente dans l’annuaire est vérifiée séparément.',
    policyUnavailable:
      'La politique authentifiée de l’opérateur n’est pas encore disponible dans cette application. L’export public reste indisponible avant son installation.',
    exportPublic: 'Exporter les preuves publiques de l’annuaire',
    check: 'Vérifier l’installation',
    exportLabel: 'Export public pour l’opérateur',
    download: 'Télécharger l’export public',
    peerAddress: 'Adresse du bot installé :',
    stepExport:
      'Exportez les preuves publiques de ce compte et remettez le fichier à l’opérateur.',
    stepInstall:
      'L’opérateur vérifie le compte, le réseau et les relais, puis installe l’ensemble public complet dans les deux relais, le bot et cette application.',
    stepCheck:
      'Vérifiez l’installation. La messagerie reste désactivée tant que tous les participants ne signalent pas le même ensemble approuvé.',
    participants: {
      'relay-a': 'Relais A',
      'relay-b': 'Relais B',
      'bot': 'Robot',
    },
    participant: {
      unchecked: 'non vérifié',
      matched: 'ensemble approuvé installé',
      unavailable: 'aucun état d’installation disponible',
      mismatch: 'installation différente ou incomplète',
    },
    reasons: {
      'account-unavailable':
        'Déverrouillez ce compte ou terminez d’abord sa configuration.',
      'policy-missing':
        'L’opérateur n’a pas installé de politique réseau dans cette application. L’export public reste indisponible avant son installation.',
      'policy-invalid':
        'La politique installée par l’opérateur n’est pas valide. Demandez-lui de la réinstaller.',
      'policy-expired':
        'La politique de l’opérateur est hors de sa période de validité. Demandez-lui une politique à jour.',
      'relay-not-in-policy':
        'Le relais de cette application ne figure pas dans la politique de l’opérateur.',
      'bundle-missing':
        'L’opérateur n’a pas encore installé d’ensemble approuvé dans cette application. Exportez, remettez le fichier, puis vérifiez de nouveau.',
      'bundle-invalid':
        'L’ensemble approuvé installé n’est pas valide. Demandez à l’opérateur de le réinstaller.',
      'bundle-foreign-policy':
        'L’ensemble approuvé a été créé pour une autre politique d’opérateur.',
      'bundle-not-this-account':
        'L’ensemble approuvé ne contient pas les preuves publiques exactes de ce compte. Exportez de nouveau et demandez une réinstallation.',
      'forwarding-unavailable':
        'Ce compte et le bot doivent utiliser le relais configuré pour cette application. Le transfert entre relais n’est pas encore disponible.',
      'participant-unavailable':
        'Au moins un relais ou le bot n’a pas signalé son installation. Rien n’a été envoyé ni payé.',
      'participant-mismatch':
        'Au moins un relais ou le bot signale une installation différente. Rien n’a été envoyé ni payé.',
      'enrollment-required':
        'Appuyez sur Vérifier l’installation pour terminer l’inscription à l’annuaire sur cet appareil.',
      'admission-failed':
        'Les preuves de l’annuaire n’ont pas pu être admises. Rien n’a été envoyé ni payé.',
      'changed-during-check':
        'Un relais ou le bot a changé pendant la vérification. Vérifiez de nouveau.',
      'account-changed':
        'Le compte a changé pendant la vérification. Vérifiez de nouveau.',
    },
    publicOnly:
      'L’export contient uniquement des preuves publiques. La vérification peut publier la fiche publique signée de ce compte auprès de son relais ; elle n’envoie aucun message et ne dépense aucuns fonds.',
  },

  accountRecovery,
  forum: {
    postsLabel: 'messages',
    noPosts: 'Aucun message pour le moment.',
    outageTitle: 'Forum indisponible',
    outageDescription:
      'Impossible de se connecter au relais du forum. Veuillez vérifier votre connexion ou réessayer.',
    outageBanner:
      'Le relais du forum est actuellement inaccessible. Affichage des messages enregistrés.',
    degradedTitle: 'Connexion dégradée',
    degradedBanner: 'Certains sujets du forum n’ont pas pu être mis à jour.',
    retry: 'Réessayer',
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
    refreshStatus: 'Actualiser le statut',
    posting: 'Publication en cours…',
    postCreated: 'Message publié dans {topic} !',
    replyParentLoading: 'Chargement du message auquel vous répondez…',
    replyParentUnavailable:
      'Le message auquel vous répondez n’a pas pu être chargé. Vous pouvez réessayer.',
    retryReplyParent: 'Réessayer',
    postedRefreshFailed:
      'Votre message a été publié, mais l’actualisation a échoué. Rechargez pour le voir. Ne le publiez pas à nouveau.',
    postOutcomeUnknown:
      'Votre message a peut-être été publié. Rechargez pour le vérifier. Ne le publiez pas à nouveau.',
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
    confirmPrompt: 'Payer {price} à {name} ({address}) pour « {item} » ?',
    confirmBuy: 'Confirmer et payer {price}',
    cancel: 'Annuler',
    confirmGroupLabel: 'Confirmer l’achat de {item}',
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
  blackjackDealer: {
    silentTitle: "Le croupier n'a pas répondu",
    silentBody:
      "Votre coup a été envoyé et payé, mais aucune réponse n'est revenue. Le croupier est peut-être hors ligne, et un coup envoyé pendant qu'il était hors ligne peut ne jamais être vu.",
    silentWait: 'Attendez que le croupier soit de retour avant de réessayer.',
    silentNoResend:
      'Cette mise ne peut pas être renvoyée depuis ici : elle serait payée deux fois.',
    silentRefund:
      "Votre mise n'est pas remboursée automatiquement (seule une mise refusée par le croupier l'est). Si le croupier reste hors ligne, contactez la personne qui l'exploite.",
    resendConfirm:
      "Renvoyer mon coup ({action}). Je comprends qu'il est payé de nouveau et que, si le premier arrive aussi, il peut être joué deux fois.",
    resend: 'Renvoyer mon coup',
  },
  blackjackHand: {
    bet: 'Votre mise : {amount} MON',
    betUnverified: 'Votre mise',
    betWaiting: 'En attente de la distribution par le croupier.',
    payout:
      'Gain : {amount} MON (mise remboursée plus gains éventuels), envoyé par le croupier après la révélation de la main.',
  },
  persistentStorage: {
    tab: 'Stockage',
    heading: 'Stockage persistant',
    granted: 'Stockage persistant : accordé',
    notGranted: 'Stockage persistant : non accordé',
    unsupported: 'Stockage persistant : indisponible',
    unknown: 'Stockage persistant : vérification…',
    explainGranted:
      'Votre navigateur a accepté de conserver les données de cette application sauf si vous les effacez vous-même. Votre phrase de récupération reste la seule sauvegarde si vous perdez cet appareil.',
    explainNotGranted:
      'Votre navigateur peut supprimer les données de cette application, dont votre phrase de récupération enregistrée, lorsqu’il manque d’espace ou, dans Safari, après 7 jours sans visite sauf si l’application est ajoutée à l’écran d’accueil. Votre phrase de récupération est la seule sauvegarde.',
    explainUnsupported:
      'Le stockage persistant est indisponible (cette page n’est pas un contexte sécurisé ou le navigateur ne le prend pas en charge) : le navigateur peut supprimer les données de cette application (Safari le fait après 7 jours sans visite sauf si l’application est ajoutée à l’écran d’accueil). Votre phrase de récupération est la seule sauvegarde.',
    request: 'Demander au navigateur de conserver mes données',
    confirmSeed: 'Confirmer ma phrase de récupération',
    seedConfirmed: 'Votre phrase de récupération est confirmée.',
  },
  blackjackWelcome: {
    title: 'Table de blackjack',
  },
  blackjackBet: {
    doubleUnavailable:
      'Impossible de doubler : la mise initiale ou la discussion n’est pas prête.',
    doublePending:
      'Le paiement pour doubler est enregistré. En attente du croupier ; des options de récupération apparaîtront dans cette discussion si le coup reste sans réponse.',
    doublePaidTitle: 'Double payé, en attente de livraison ou de réponse',
    doubleSignedBody:
      'Votre mise supplémentaire de {amount} MON pour doubler auprès de {name} ({address}) a peut-être été payée. Vérifiez le paiement avant de réessayer ; aucune nouvelle mise ne sera envoyée.',
    doublePendingBody:
      'Votre mise supplémentaire de {amount} MON pour doubler auprès de {name} ({address}) est payée. Réessayer envoie le même coup avec le même paiement. Conservez cet enregistrement jusqu’à la confirmation du croupier ou la vérification du résultat.',
    playAgainTitle: 'Rejouer',
    faucetHint:
      'Il vous faut des MON pour jouer ? Cette application utilise des MON de testnet, sans valeur réelle. Le faucet de démonstration alimente automatiquement les nouveaux profils ; si rien n’est arrivé, demandez à l’opérateur de la démo de vous en envoyer.',
    title: 'Commencer une main de blackjack',
    amountLabel: 'Montant de la mise',
    amountAria: 'Montant de la mise en MON',
    limits: 'Limites de la table : {min} à {max} MON',
    notice:
      'Votre mise est un vrai transfert de MON vers {name} ({address}). À utiliser uniquement avec un croupier de blackjack.',
    confirm:
      'Je comprends que {amount} MON seront envoyés à {name} ({address})',
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
  a11y: {
    openNavigation: 'Ouvrir le menu de navigation',
    addContact: 'Ajouter un contact',
    addTopic: 'Ajouter un sujet',
    deleteTopic: 'Supprimer le sujet {topic}',
    deleteContact: 'Supprimer le contact {name}',
    sendMessage: 'Envoyer le message',
    voteUp: 'Voter pour',
    voteDown: 'Voter contre',
    forumRefresh: 'Actualiser le forum',
    newPost: 'Nouvelle publication',
    forumSettings: 'Paramètres du forum',
    topicSettings: 'Paramètres du sujet',
    chatMenu: 'Options de la conversation',
    closeInfo: 'Retour à la conversation',
    exitSelectMode: 'Quitter la sélection de messages',
    attachmentOptions: 'Options de pièce jointe',
    stampPayment: 'Paiement du timbre',
    messageActions: 'Afficher les actions du message',
    replyToMessage: 'Répondre au message',
    forwardMessage: 'Transférer le message',
    messageInfo: 'Infos du message',
    deleteMessage: 'Supprimer le message',
    resendMessage: 'Renvoyer le message',
    cancelReply: 'Annuler la réponse',
    scrollToLatest: 'Aller aux derniers messages',
    copyAddress: "Copier l'adresse",
    connectRelay: 'Se connecter au relais',
    choosePhoto: 'Choisir une photo de profil',
    previousAvatar: 'Avatar précédent',
    nextAvatar: 'Avatar suivant',
    chooseFile: 'Choisir un fichier',
    openInExplorer: "Ouvrir la transaction dans l'explorateur de blocs",
  },
  leftDrawer: {
    noForums: 'Aucun forum découvert pour le moment.',
    settings: 'Paramètres',
    contacts: 'Contacts',
    forum: 'Forum',
    wallet: 'Portefeuille',
    railLabel: 'Sections de la barre latérale',
    contactsUnreadOne: 'Contacts, {count} message non lu',
    contactsUnreadOther: 'Contacts, {count} messages non lus',
  },
  walletPanel: {
    title: 'Portefeuilles',
    mainWallet: 'Portefeuille principal',
    monad: 'Monad',
    send: 'Envoyer des MON',
    receive: 'Recevoir des MON',
    showSeed: 'Afficher la phrase de récupération',
    confirmSeed: 'Confirmer la phrase de récupération',
    balanceLoading: 'Chargement du solde…',
    balanceUnavailable: 'Solde indisponible. Nouvelle tentative.',
    balanceStale: '{balance} (dernière valeur connue)',
    failedLoadAddress: 'Échec du chargement de l’adresse du portefeuille Monad',
    unableCopyAddress: 'Impossible de copier l’adresse Monad',
  },
  chatList: {
    noContactMessage: 'Ajoutez des contacts depuis le tiroir ci-dessus...',
    youPrefix: 'Vous : {text}',
    themPrefix: 'Contact : {text}',
    balance: 'Solde',
    balanceStale: '(dernière valeur connue)',
    directMessages: 'Messages privés',
  },
  selfChat: {
    you: 'Vous',
  },
  outgoing: {
    sending: 'Envoi…',
    paymentPending:
      'Paiement en attente, nouvelle tentative automatique. Vous ne serez pas débité à nouveau.',
    paymentQueued:
      "En attente de la fin d'un message précédent. Celui-ci sera envoyé ensuite.",
    paymentChecking: "Vérification de l'état du paiement…",
    reasonUnreachable: 'Impossible de joindre le serveur.',
    reasonUnavailable: 'Ce relais ne propose pas la messagerie.',
    reasonRejected: 'Le relais a refusé le message.',
    reasonInterrupted: "L'envoi a été interrompu avant son terme.",
    reasonUnverified: "La remise n'a pas pu être confirmée.",
    reasonRecovered: 'Un message précédent a été remis entre-temps.',
    reasonInsufficientFunds:
      'Les fonds sont insuffisants pour envoyer ce message.',
    reasonError: 'Le message n’a pas pu être envoyé.',
    retry: 'Réessayer',
    retryHint:
      "Réessayer renvoie le même paiement tant qu'il est valide. Un nouveau paiement n'est fait que s'il ne l'est plus.",
    discard: 'Supprimer',
    discardConfirmTitle: 'Supprimer le message ?',
    discardConfirmMessage:
      'Il sera retiré de votre conversation. Si son paiement est encore en attente, il pourrait tout de même être remis.',
    sendAgainTitle: 'Renvoyer ?',
    sendAgainUnverified:
      "Nous n'avons pas pu confirmer si le premier paiement a été remis. Renvoyer pourrait vous débiter une seconde fois.",
    sendAgainRecovered:
      "Un message en attente précédent a été remis pendant l'envoi de celui-ci. Le renvoyer comme nouveau message ?",
    sendAgain: 'Renvoyer',
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
  chatMessageMenu: {
    messageCopied: 'Message copié dans le presse-papier',
  },
  notifications: {
    addressCopied: 'Adresse copiée dans le presse-papier.',
    insufficientStamp:
      'Le timbre est trop petit, le destinataire ne sera pas notifié.',
    seedCopied:
      'Votre phrase de récupération a été copiée dans votre presse-papier.',
    sentTransaction: 'Transaction envoyée',
    unexpectedError: 'Une erreur s’est produite. Veuillez réessayer.',
    viewAction: 'Voir',
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
    networkTitle: 'Testnet Monad',
    testnetDisclaimer:
      "Frank fonctionne sur le testnet Monad. Toutes les transactions utilisent des MON de testnet, qui n'ont aucune valeur monétaire réelle. N'envoyez jamais de fonds réels.",
    economicModelTitle: 'Actions payantes et coûts',
    costsDisclaimer:
      "Des coûts de réseau et de timbre s'appliquent aux actions sortantes. Le montant exact des frais ou du timbre est toujours affiché avant de confirmer une action.",
    directMessagesTitle: 'Messages directs',
    directMessagesDesc:
      "Payés directement au destinataire sous forme de timbre de boîte de réception, afin d'éviter le spam et d'indemniser la distribution.",
    topicActionsTitle: 'Publications et votes de forum',
    topicActionsDesc:
      'Détruits de manière permanente sur la blockchain (burn) pour publier des messages ou enregistrer des votes sur les sujets publics.',
    fundingTitle: 'Financement de testnet',
    fundingDesc:
      "Les nouveaux comptes reçoivent automatiquement des MON de testnet via le faucet de démonstration. Vous pouvez également consulter votre adresse et obtenir des fonds de testnet depuis l'écran Recevoir après la configuration.",
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
      'Notez votre phrase de récupération et gardez-la en lieu sûr. Si vous la perdez, personne ne pourra récupérer votre compte.',
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
      'Une phrase de récupération est déjà enregistrée sur cet appareil, mais ce compte n’a pas encore de nom. Confirmez-la et choisissez un nom pour terminer. Elle n’est pas remplacée, sauf si vous importez une autre phrase que vous possédez déjà.',
    confirmStoredFirst:
      'Confirmez ou copiez d’abord votre phrase de récupération enregistrée.',
    importDifferentPhrase: 'J’ai déjà une autre phrase de récupération',
    importDifferentContinue: 'Continuer vers l’importation',
    invalidWordCount:
      'Une phrase de récupération doit contenir 12, 15, 18, 21 ou 24 mots.',
    unrecognizedWords:
      'Un ou plusieurs mots ne sont pas reconnus. Vérifiez l’orthographe.',
    invalidChecksum:
      'La somme de contrôle de la phrase de récupération est invalide. Vérifiez l’ordre et l’orthographe de vos mots.',
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
    wordError: 'Le mot n° {n} ne correspond pas',
    recheck:
      'Certains mots ne correspondent pas à votre phrase de récupération. Vérifiez les mots n° : {positions}.',
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
    introNameOnly:
      'Recommencer la configuration le remplacerait. Ce profil ne possède ni phrase de récupération ni fonds de portefeuille sur cet appareil.',
    confirmed: 'Votre phrase de récupération actuelle est confirmée.',
    cancel: 'Annuler et revenir à mon compte',
    confirmCurrent: 'Confirmer ma phrase de récupération actuelle',
    replaceToggle: 'Remplacer ce compte',
    warning:
      'Remplacer ce compte supprimera de cet appareil votre phrase de récupération, votre nom et votre profil actuels. Si vous n’avez pas sauvegardé la phrase, le compte et ses fonds pourraient être irrécupérables.',
    warningNameOnly:
      'Remplacer ce compte supprimera de cet appareil votre nom et votre profil actuels.',
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
    wipeAndSave: 'Supprimer les messages du relais',
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
    failedLoadBalance: 'Échec du chargement du solde du portefeuille Monad',
    unableCopyAddress: 'Impossible de copier l’adresse Monad',
  },
  sendAddressDialog: {
    sendToAddress: "Envoyer vers l'adresse",
    enterBitcoinCashAddress: "Saisissez l'adresse de destination...",
    enterAmount: 'Saisissez le montant (MON)',
    cancel: 'Annuler',
    send: 'Envoyer',
    review: 'Vérifier',
    reviewTitle: 'Vérifier le transfert',
    network: 'Réseau',
    recipient: 'Destinataire',
    amount: 'Montant',
    estimatedFee: 'Frais estimés',
    feeUnavailable: 'Indisponible',
    maxTotal: 'Total maximal',
    maxTotalWithFee: '{amount} {unit} (+ frais de réseau)',
    irreversibleWarning:
      'Les transactions sur la blockchain sont irréversibles. Vérifiez le destinataire et le réseau avant de confirmer.',
    editTransfer: 'Modifier',
    confirmAndSend: 'Confirmer et envoyer',
    definitelyNotBroadcast:
      "La transaction n'a pas été diffusée. Aucun fond n'a été transféré.",
    potentiallyBroadcast:
      'La transaction a été signée ({txHash}) et a peut-être été diffusée. Vérifiez votre solde ou le statut de la transaction avant de réessayer.',
    invalidTransfer:
      'Saisissez une adresse Monad et un montant de MON valides.',
    failedSendTransaction: 'Échec de l’envoi de la transaction Monad',
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
    title: 'Paramètres',
    back: 'Retour',
    openMenu: 'Ouvrir le menu',
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
    seedEntry: 'Phrase de récupération',
    importSeed: 'Rappel des mémoires perdues', //? Recover past memories
    invalidSeed: 'Ce n’est pas une phrase de récupération valide.',
    nameHint: 'Identifiant tel que vu par vos correspondants',
    enterSeed: 'Entrez votre phrase de récupération...',
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
    warning: 'Supprimer tous les messages du relais ?',
    warningMsg:
      'Cette opération supprime définitivement tous les messages stockés sur le serveur relais, ainsi que les copies locales dans cette application. Votre portefeuille, votre phrase de récupération et vos fonds ne sont pas concernés.',
    cannotBeUndone: 'Cette opération est irréversible.',
    cancel: 'Annuler',
    wipe: 'Supprimer tous les messages',
    spinnerText: 'Suppression des messages…',
  },
  seedPhraseDialog: {
    close: 'Fermer',
    cancel: 'Annuler',
    seedPhrase: 'Phrase de récupération',
    warningTitle: 'Avertissement de sécurité',
    warningBody:
      'Assurez-vous que personne ne regarde votre écran. Méfiez-vous du partage d’écran, des regards indiscrets, des captures d’écran et de l’historique du presse-papiers.',
    disclosureText:
      'Quiconque obtient votre phrase de récupération peut accéder à tous vos fonds et messages et les dérober définitivement.',
    revealButton: 'Révéler la phrase de récupération',
    hideButton: 'Masquer',
    copyButton: 'Copier',
    copied: 'Copié !',
    copiedToast: 'Phrase de récupération copiée dans le presse-papiers',
    keepPrivateNotice:
      'Gardez ceci secret. Ne partagez pas et ne faites pas de capture d’écran.',
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
