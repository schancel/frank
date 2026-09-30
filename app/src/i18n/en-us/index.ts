// This is just an example,
// so you can safely delete all default props below

export default {
  agree: 'Agree',
  chat: {
    donationMessage:
      'Thank you for participating in our vision of the future of online communications. Please consider donating to our efforts by sending real BCH to bitcoincash:qq7vt04md0pt6fk5szhcx4cgsfuzmppy5u4hxshr4a',
  },
  stampPreparation: {
    checking: 'Checking private stamp accounts…',
    funding:
      'Preparing a private stamp account ({completed}/{total} on-chain transactions; up to {feeReserve} {unit} fee reserve each)…',
    ready: 'Private stamp account ready; sending…',
    posting: 'Posting…',
    postedRefreshFailed:
      'Your post was published, but refreshing failed. Reload to see it. Do not post it again.',
    votedRefreshFailed:
      'Your vote was sent, but refreshing failed. Reload to see it. Do not vote again.',
  },
  chatLayout: {
    info: 'Info',
    infoTitle: 'Info',
    mute: 'Mute',
    unmute: 'Unmute',
    selectMessages: 'Select Messages',
    selectMessagesTitle: 'Select Messages',
  },
  chatInput: {
    giveLotusSecretly: 'Give Lotus Secretly',
    attachImage: 'Attach Image',
    placeHolder: 'Write a message...',
    emojiPickerTitle: 'Select an emoji',
    stampPrice: 'Stamp Price',
  },
  blackjackBet: {
    menuLabel: 'Play blackjack',
    title: 'Start a blackjack hand',
    amountLabel: 'Bet amount',
    amountAria: 'Bet amount in MON',
    limits: 'Table limits: {min} to {max} MON',
    notice:
      'Your bet is a real transfer of MON to {name} ({address}). Only use it with a blackjack dealer.',
    confirm: 'I understand {amount} MON will be sent to {name} ({address})',
    confirmRequired: 'Tick the box to confirm the transfer.',
    submit: 'Deal me in with {name} {address} ({amount} MON)',
    sending: 'Sending your bet…',
    sent: 'Bet sent. Waiting for the dealer to deal.',
    notDelivered:
      'Wager paid, bet not delivered: {message} Use Retry in the chat to send the bet again.',
    errorFormat: 'Enter a bet as a plain decimal number',
    errorInvalid: 'Enter a valid MON amount to bet',
    errorZero: 'Bet must be greater than zero',
    errorMin: 'Bet is below the table minimum ({min} MON)',
    errorMax: 'Bet is above the table maximum ({max} MON)',
    errorBalanceUnknown:
      'Your balance is not loaded yet. Try again in a moment.',
    errorBalance:
      'Not enough balance: this bet needs {needed} MON (bet plus about {rest} MON for the message stamp and fees), you have {balance} MON.',
    errorUnsent:
      'Finish the unsent wager in the chat before starting a new bet.',
    errorFunds: 'Insufficient funds: {message}',
    errorSend: 'Could not place the bet: {message}',
    unsentTitle: 'Wager paid, bet not delivered',
    unsentBody:
      'Your {amount} MON wager to {name} ({address}) was paid, but the bet message did not reach the dealer.',
    unsentTx: 'Transaction: {hash}',
    unsentRetry: 'Retry sending the bet',
    unsentRetrying: 'Sending the bet…',
    unsentFailed: 'Still not delivered: {message}',
    confirming: 'Waiting for your payment to be confirmed on the network…',
    errorPaymentFailed:
      'The payment transaction failed on the network, so no wager was placed.',
    paymentPending:
      'Your payment is still confirming. It is saved in the chat; use Check payment there.',
    paymentUnknown:
      'The network has not shown your payment yet. It may still arrive, so it is saved in the chat; use Check payment there. Do not assume nothing was paid.',
    unsentSigned: 'Payment not confirmed',
    unsentSignedBody:
      'A {amount} MON wager to {name} ({address}) was sent, but the network has not confirmed it yet.',
    unsentDealerSilent: 'Waiting for the dealer',
    unsentDealerSilentBody:
      'Your bet for {amount} MON to {name} ({address}) was delivered but the dealer has not answered.',
    unsentDealerUnconfirmed: 'The dealer could not verify your payment yet',
    checkPayment: 'Check payment',
    checking: 'Checking the network…',
    paymentStillPending: 'The payment is still pending on the network.',
    paymentNotFound:
      'The network does not know this payment (yet). If you are sure it was never sent, you can discard this record.',
    paymentFailedRemoved:
      'The payment transaction failed on the network; nothing was paid. The record was removed.',
    dismiss: 'Discard this record',
    dismissWarning:
      'If this wager was actually paid, discarding the record can lose the money. Discard only if you are sure it was not paid or was refunded.',
    dismissConfirm: 'Yes, discard it',
    dismissCancel: 'Keep it',
    loadError: 'Saved wager records could not be read: {message}',
  },
  leftDrawer: {
    settings: 'Settings',
    contacts: 'Contacts',
    forum: 'Forum',
    railLabel: 'Sidebar sections',
    contactsUnreadOne: 'Contacts, {count} unread message',
    contactsUnreadOther: 'Contacts, {count} unread messages',
  },
  chatList: {
    noContactMessage: 'Add contacts from the drawer above...',
    balance: 'Balance',
    balanceStale: '(last known)',
    directMessages: 'Direct Messages',
  },
  mailboxStatus: {
    unavailable:
      'Messaging service unavailable: this relay does not offer messaging, so you will not receive messages.',
    unreachable:
      "Can't reach the server. You may not be receiving messages; retrying.",
    rateLimited: 'The server asked us to slow down. Retrying shortly.',
    unauthorized: 'The server rejected your messaging login. Retrying.',
  },
  chatMessage: {
    noPayloadFound: 'Unable to find message payload',
  },
  chatRightDrawer: {
    stampPrice: 'Stamp Price',
    sendLotus: 'Send Lotus',
    notifications: 'Notifications',
    clearHistory: 'Clear History',
    deleteChat: 'Delete Chat',
    unknownContact: 'Unknown',
  },
  sendLotusDialog: {
    sendLotusTo: 'Send Lotus to',
    amountHint: 'Set the amount of Lotus to be sent.',
    amountPlaceholder: 'Enter number of Lotus...',
    memoHint: 'Attach a memo to the payment.',
    memoPlaceholder: 'Enter the memo...',
    sendBtnLabel: 'Send',
    cancelBtnLabel: 'Cancel',
  },
  sendFileDialog: {
    sendFile: 'Send File',
    captionHint: 'Attach a memo to the payment.',
    captionPlaceholder: 'Enter the memo...',
    sendBtnLabel: 'Send',
    cancelBtnLabel: 'Cancel',
  },
  setup: {
    loginOrSignUp: 'Login/Sign Up',
    welcome: 'Welcome',
    welcomeToStampChat: 'Welcome to Frank!',
    eulaDisclaimer:
      'Frank is experimental software. It may contain bugs that delay messages or cause a loss of funds. Only use amounts you can afford to lose.',
    eulaYouUnderstand:
      'By clicking "Agree", you acknowledge that Frank is provided "as is", without warranties of any kind, express or implied.',
    setupWallet: 'Character Setup',
    eula: 'EULA',
    deposit: 'Deposit Lotus',
    settings: 'Settings',
    back: 'Back',
    seedWarning:
      "Do not forget your character's secret name, you will never be able to remember them again.",
    searchingRelay: 'Searching for existing relay data...',
    networkErrorRelayDied: 'Network Error: Relay server connection died. ',
    networkErrorRelayUnexpected: 'Network error: Relay errored unexpectedly.',
    requestingPayment: 'Requesting Payment...',
    sendingPayment: 'Sending Payment...',
    uploadingMetaData: 'Uploading Metadata...',
    openingInbox: 'Opening Inbox...',
    profileImageLargeError:
      'Profile image is too large, select a smaller image.',
    continue: 'Continue',
    finish: 'Finish',
    generatingWallet: 'Generating wallet...',
    gatheringBalances: 'Gathering balances...',
    watchingWallet: 'Watching wallet...',
    searchingExistingMetaData: 'Searching for existing registry metadata...',
    errorContactRegistry: 'Unable to contact registry',
    storedSeedMismatch:
      'The recovery phrase on this device cannot be replaced from this screen.',
    replaceNotAcknowledged:
      'This account cannot be replaced without confirming the replacement.',
    accountSetupNext: 'Next',
    depositStepNext: 'Next',
  },
  accountStep: {
    newAccount: 'New Account',
    importAccount: 'Import Account',
    copyRecoveryPhrase: 'Copy recovery phrase',
    refreshRecoveryPhrase: 'Generate a new recovery phrase',
    resumeNotice:
      'A recovery phrase is already stored on this device, but this account has no name yet. Your phrase will not be changed. Confirm it and choose a name to finish.',
  },
  seedConfirm: {
    unavailable:
      'Confirmation is unavailable because this device has no secure random number generator. Go back and try again, or use another browser.',
    stepTitle: 'Confirm phrase',
    title: 'Confirm your recovery phrase',
    instructions:
      'Enter the requested words from the recovery phrase you wrote down. Your account is only created once they match.',
    wordLabel: 'Word #{n}',
    check: 'Check my answers',
    error:
      'One or more words do not match your recovery phrase. Check your copy and try again.',
    success: 'Recovery phrase confirmed. You can finish setup.',
    showPhrase: 'Show my recovery phrase again',
    hidePhrase: 'Hide my recovery phrase',
    phraseLabel: 'Your recovery phrase, in order',
  },
  backupReminder: {
    regionLabel: 'Recovery phrase backup reminder',
    message:
      'You have not confirmed your recovery phrase yet. Confirm you saved it so you can always recover your account.',
    confirm: 'Confirm now',
    dismiss: 'Later',
  },
  replaceGuard: {
    title: 'You already have an account on this device',
    intro:
      'Setting up again would replace it. Your recovery phrase is the only way to get this account and its funds back.',
    confirmed: 'Your current recovery phrase is confirmed.',
    cancel: 'Cancel and go back to my account',
    confirmCurrent: 'Confirm my current recovery phrase',
    replaceToggle: 'Replace this account',
    warning:
      'Replacing this account will remove your current recovery phrase, name and profile from this device. If you have not backed the phrase up, the account and any funds may be unrecoverable.',
    typeLabel: 'Type {word} to continue',
    word: 'REPLACE',
    mismatch: 'That does not match. Type the word exactly to continue.',
    replace: 'Replace this account',
  },
  newContactDialog: {
    newContact: 'New Contact',
    enterBitcoinCashAddress: 'Enter address (0x...)',
    loading: 'Looking up contact',
    notFound: 'Not Found',
    found: 'Contact found: {name}',
    ownAddress:
      "This is your own address. You can't add yourself as a contact.",
  },
  newTopicDialog: {
    newTopic: 'Add Topic',
    enterTopic: 'Enter topic...',
    topicNameMinLength: 'Please use minimum of 3 characters',
    topicNameRules: 'A-Z, a-z, 0-9, and periods are the only valid characters',
    add: 'Add',
    cancel: 'Cancel',
  },
  topicDrawer: {
    offering: 'Offering:',
    filter: 'Filter:',
  },
  SettingPanel: {
    newContact: 'New Contact',
    contacts: 'Contacts',
    sendMonad: 'Send MON',
    receiveMonad: 'Receive MON',
    profile: 'Profile',
    settings: 'Settings',
    wipeAndSave: 'Remote Wipe Wallet',
    changeLog: 'Changelog',
    showSeed: 'Show Seed',
    confirmSeed: 'Confirm Recovery Phrase',
    panelLabel: 'Settings',
  },
  receiveBitcoinDialog: {
    walletStatus: 'Wallet Status',
    balanceUnavailable: 'Balance unavailable. Retrying.',
    noFundsHint:
      'Your balance is 0. This app uses testnet MON, which has no real value. The demo faucet funds new profiles automatically; if nothing arrives after a minute, ask the demo operator to send testnet MON to the address below.',
    close: 'Close',
    addressCopied: 'Address copied to clipboard',
  },
  sendAddressDialog: {
    sendToAddress: 'Send to Address',
    enterBitcoinCashAddress: 'Enter address (0x...)',
    enterAmount: 'Enter Amount (MON)',
    cancel: 'Cancel',
    send: 'Send',
  },
  contactBookDialog: {
    contacts: 'Contacts',
    search: 'Search...',
    close: 'Close',
  },
  contactItem: {
    address: 'Address',
    inboxPrice: 'Inbox Price',
    notFound: 'Not Found',
  },
  settings: {
    appearance: 'Appearance',
    networking: 'Networking',
    contactRefreshInterval: 'Contact Refresh Interval (minutes)',
    contactRefreshIntervalHint: 'Interval between contact updates (minutes)',
    darkMode: 'Dark Mode',
    saveSettings: 'Save',
    cancelSettings: 'Cancel',
    languageSelectorCaption: 'Language',
  },
  profile: {
    name: "Character's Public Name",
    seedEntry: "Character's Secret Name",
    importSeed: 'Recover past memories',
    invalidSeed: 'Unknown secret name...',
    nameHint: 'Name displayed to others',
    enterSeed: "Enter your character's secret name...",
    pleaseType: 'Please be more creative',
    bio: 'Bio',
    bioHint: 'Short biolography displayed to others',
    uploadAvatar: 'Upload Avatar',
  },
  clearHistoryDialog: {
    cancel: 'Cancel',
    clear: 'Clear',
    message: 'Are you sure you want to clear all chat history with',
  },
  deleteChatDialog: {
    cancel: 'Cancel',
    delete: 'Delete',
    message: 'Are you sure you want to delete all chat history with',
  },
  deleteMessageDialog: {
    cancel: 'Cancel',
    delete: 'Delete',
    message: 'Are you sure you want to delete this message?',
  },
  imageDialog: {
    close: 'Close',
  },
  profileDialog: {
    cancel: 'Cancel',
    update: 'Update',
    avatarTooLarge: 'Profile avatar is too large, select a smaller image.',
    unableContactRelay: 'Unable to contact relay server.',
    pushingProfile: 'Pushing new Profile...',
    invalidName:
      'Enter a public name: 1-128 characters, no control characters.',
    profile: 'Profile',
  },
  wipeWallet: {
    warning: 'WARNING!',
    warningMsg:
      'This will delete all messages from the remove server and consolidate any funds associated with them back into your HD wallet.',
    cannotBeUndone: 'This cannot be undoned!',
    cancel: 'Cancel',
    wipe: 'Wipe All Remote Content',
    spinnerText: 'Deleting All Messages',
  },
  seedPhraseDialog: {
    seedPhrase: 'Seed Phrase',
    close: 'Close',
  },
  transactionDialog: {
    backingTransactions: 'Backing Transactions',
    txId: 'Transaction ID',
    txType: 'Type',
    txAddress: 'Address',
    txAmount: 'Amount',
  },
  close: 'Close',
}
