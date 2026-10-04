// This is just an example,
// so you can safely delete all default props below

import { en as accountRecovery } from '../account-recovery'

export default {
  directoryProvisioning: {
    title: 'Directory installation',
    pending: 'Pending operator installation',
    checking: 'Checking the installed configuration…',
    ready:
      'Ready: local demo installation verified. Encrypted messaging is enabled.',
    explanation:
      'Both relays and the bot must have the same approved public account bundle. Fresh directory admission is checked separately.',
    policyUnavailable:
      'Authenticated operator policy is not available in this app yet. Public export is unavailable until it is installed.',
    exportPublic: 'Export public directory evidence',
    check: 'Check installation',
    exportLabel: 'Public export for the operator',
    download: 'Download public export',
    peerAddress: 'Installed bot address:',
    stepExport:
      'Export this account’s public evidence and give the file to the operator.',
    stepInstall:
      'The operator checks the account, network and relay tuples, then installs the complete public bundle into both relays, the bot and this app.',
    stepCheck:
      'Check installation. Messaging stays off until every participant reports the same approved bundle.',
    participants: {
      'relay-a': 'Relay A',
      'relay-b': 'Relay B',
      'bot': 'Bot',
    },
    participant: {
      unchecked: 'not checked',
      matched: 'approved bundle installed',
      unavailable: 'no installation status available',
      mismatch: 'different or incomplete installation',
    },
    reasons: {
      'account-unavailable': 'Unlock or finish setting up this account first.',
      'policy-missing':
        'The operator has not installed a network policy in this app. Public export is unavailable until it is installed.',
      'policy-invalid':
        'The installed operator policy is not valid. Ask the operator to reinstall it.',
      'policy-expired':
        'The operator policy is outside its validity period. Ask the operator for a current policy.',
      'relay-not-in-policy':
        'This app’s relay is not one of the relays in the operator policy.',
      'bundle-missing':
        'The operator has not installed an approved bundle in this app yet. Export, hand over the file, then check again.',
      'bundle-invalid':
        'The installed approved bundle is not valid. Ask the operator to reinstall it.',
      'bundle-foreign-policy':
        'The approved bundle was made for a different operator policy.',
      'bundle-not-this-account':
        'The approved bundle does not contain this account’s exact public evidence. Export again and ask the operator to reinstall.',
      'forwarding-unavailable':
        'This account and the bot must use the relay this app is configured for. Relay forwarding is not available yet.',
      'participant-unavailable':
        'At least one relay or the bot did not report its installation. Nothing was sent or paid.',
      'participant-mismatch':
        'At least one relay or the bot reports a different installation. Nothing was sent or paid.',
      'enrollment-required':
        'Press Check installation to finish joining the directory on this device.',
      'admission-failed':
        'The directory evidence could not be admitted. Nothing was sent or paid.',
      'changed-during-check':
        'A relay or the bot changed while it was being checked. Check again.',
      'account-changed': 'The account changed during the check. Check again.',
    },
    publicOnly:
      'The export contains public evidence only. Checking may publish this account’s signed public directory record to its relay; it never sends a message or spends funds.',
  },

  accountRecovery,
  agree: 'Agree',
  chat: {
    stampPreparationChecking: 'Checking private stamp accounts…',
    stampPreparationFunding:
      'Preparing private stamp accounts ({completed}/{total} on-chain transactions; up to {feeReserve} {unit} fee reserve each)…',
    stampPreparationReady: 'Private stamp accounts ready; sending message…',
    donationMessage:
      'Thank you for participating in our vision of the future of online communications. Please consider donating to our efforts by sending real BCH to bitcoincash:qq7vt04md0pt6fk5szhcx4cgsfuzmppy5u4hxshr4a',
  },
  stampPreparation: {
    refreshStatus: 'Refresh status',
    posting: 'Posting…',
    postCreated: 'Post created in {topic}.',
    replyParentLoading: 'Loading the post you are replying to…',
    replyParentUnavailable:
      'The post you are replying to could not be loaded. You can try again.',
    retryReplyParent: 'Try again',
    postedRefreshFailed:
      'Your post was published, but refreshing failed. Reload to see it. Do not post it again.',
    postOutcomeUnknown:
      'Your post may have been published. Reload to check for it. Do not post it again.',
    votedRefreshFailed:
      'Your vote was sent, but refreshing failed. Reload to see it. Do not vote again.',
  },
  forum: {
    postsLabel: 'posts',
    noPosts: 'No posts yet.',
    outageTitle: 'Forum unavailable',
    outageDescription:
      'Could not connect to the forum relay. Please check your connection or try again.',
    outageBanner: 'Forum relay is currently unreachable. Showing saved posts.',
    degradedTitle: 'Connection degraded',
    degradedBanner: 'Some forum topics could not be updated.',
    retry: 'Retry',
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
    blackjackChallenge: 'Blackjack challenge',
    placeHolder: 'Write a message...',
    emojiPickerTitle: 'Select an emoji',
    stampPrice: 'Stamp Price',
    stampPayment: 'Stamp payment',
    stampQuickSelection: 'Quick selection from 1× to 100× the default stamp',
    stampMultiplierValue: '{multiplier}× default',
  },
  digitalGoods: {
    catalog: 'Catalog',
    buy: 'Buy',
    confirmPrompt: 'Pay {price} to {name} ({address}) for "{item}"?',
    confirmBuy: 'Confirm and pay {price}',
    cancel: 'Cancel',
    confirmGroupLabel: 'Confirm purchase of {item}',
    priceUnavailable: 'price unavailable',
    hiddenOne: '{count} more item not shown',
    hiddenMany: '{count} more items not shown',
    requested: 'Requested: {itemId}',
    fulfilled: "Here's your purchase ({itemId}):",
  },
  chatImage: {
    notShown: 'Image not shown ({reason})',
    reasonNotAnImage: 'not an image',
    reasonTooLarge: 'too large',
    reasonNotInline: 'not an inline image',
    reasonUnreadableHeader: 'unreadable image header',
    reasonEmpty: 'empty image',
    reasonDimensionsTooLarge: 'dimensions too large',
  },
  raffleDraw: {
    verified: 'Draw matches the seed commitment',
    failed: 'Verification failed: {reason}',
    explainerToggle: 'What does this show?',
    explainerShows:
      'Shows: the operator did not change the seed after committing to it, and the winner follows from the listed entrants and that seed.',
    explainerNotShown:
      'Does not show: that the listed entrants are real on-chain payments, or that no entries were left out.',
    explainerCountUnverified:
      'The round did not announce its size, so the number of entrants is not checked.',
  },
  persistentStorage: {
    tab: 'Storage',
    heading: 'Persistent storage',
    granted: 'Persistent storage: granted',
    notGranted: 'Persistent storage: not granted',
    unsupported: 'Persistent storage: unavailable',
    unknown: 'Persistent storage: checking…',
    explainGranted:
      'Your browser has agreed to keep this app’s data unless you clear it yourself. Your recovery phrase is still the only backup if you lose this device.',
    explainNotGranted:
      'Your browser may delete this app’s data, including your stored recovery phrase, when it is short on space or, in Safari, after 7 days without a visit unless the app is added to your Home Screen. Your recovery phrase is the only backup.',
    explainUnsupported:
      'Persistent storage is unavailable (this page is not a secure context or the browser does not support it), so the browser may delete this app’s data (Safari does after 7 days without a visit unless the app is added to your Home Screen). Your recovery phrase is the only backup.',
    request: 'Ask the browser to keep my data',
    confirmSeed: 'Confirm my recovery phrase',
    seedConfirmed: 'Your recovery phrase is confirmed.',
  },
  blackjackP2p: {
    challengeTitle: 'Challenge to a hand of blackjack',
    roleDealer: 'I deal',
    rolePlayer: 'I play, they deal',
    maxBet: 'Maximum bet',
    limitDealer:
      'You can offer up to {amount}: a dealer must be able to pay a doubled win (4× the bet) from its own balance.',
    limitPlayer: 'You can bet up to {amount}: what you can spend now.',
    sendChallenge: 'Send challenge',
    challengeRefused:
      'This challenge is more than your balance covers. Nothing was sent.',
    balanceUnknown: 'Your balance is not loaded yet.',
    enterAmount: 'Enter an amount greater than zero.',
    belowStamp: 'The amount cannot be below the minimum stamp ({amount}).',
    aboveOwnLimit: 'That is more than you can cover (at most {amount}).',
    aboveMaxBet: 'That is above the maximum bet of this hand ({amount}).',
    lineChallengeDealer: 'Blackjack challenge: the sender deals. Maximum bet {amount}.',
    lineChallengePlayer:
      'Blackjack challenge: the sender plays, you deal. Maximum bet {amount}.',
    lineAccept: 'Challenge accepted. Maximum bet {amount}.',
    line: {
      bet: 'Bet placed: the stamp of this message is the bet.',
      deal: 'Cards dealt.',
      hit: 'Hit.',
      stand: 'Stand.',
      double: 'Double down: the stamp of this message is the second bet.',
      card: 'Card dealt.',
      reveal: 'Hand revealed: the stamp of this message is the payout, if any.',
      refund: 'Refund: the stamp of this message is the money returned.',
    },
    playerHand: 'Player: {cards} ({total})',
    dealerHand: 'Dealer: {cards} ({total})',
    dealerShows: 'Dealer shows: {card}',
    wager: 'At stake: {amount}',
    accept: 'Accept and deal',
    betAmount: 'Your bet (at most {max})',
    bet: 'Place bet',
    hit: 'Hit',
    stand: 'Stand',
    double: 'Double down (+{amount})',
    payAndReveal: 'Pay {amount} and reveal',
    refund: 'Refund {amount}',
    refundBet: 'Return the bet ({amount}) instead of dealing',
    waitAccept: 'Waiting for the other side to accept.',
    waitBet: 'Waiting for the bet.',
    waitDealer: 'Waiting for the dealer.',
    waitPlayer: "Waiting for the player's move.",
    waitReveal: 'Waiting for the dealer to reveal and pay.',
    dealing: 'Dealing…',
    verified: 'The cards match the dealer’s commitment.',
    badReveal:
      'The dealer sent a reveal that does not match its commitment. The hand is not settled.',
    noSeed:
      'This device does not hold the seed of this hand, so it cannot deal. You can return the bet.',
    refundOwed: 'The dealer owes you a refund of {amount}.',
    refunded: 'The dealer returned the bet ({amount}).',
    noPayout: 'Nothing is paid out.',
    paid: 'The dealer paid {amount}.',
    shortPaid: 'The dealer owed {owed} but paid {paid}.',
    outcome: {
      player: {
        player_win: 'You win.',
        dealer_win: 'The dealer wins.',
        push: 'Push: your stake comes back.',
        player_blackjack: 'Blackjack! You win 3:2.',
      },
      dealer: {
        player_win: 'The player wins.',
        dealer_win: 'You win.',
        push: 'Push: the stake goes back.',
        player_blackjack: 'The player has blackjack and wins 3:2.',
      },
    },
  },
  a11y: {
    openNavigation: 'Open navigation menu',
    addContact: 'Add contact',
    addTopic: 'Add topic',
    deleteTopic: 'Delete topic {topic}',
    deleteContact: 'Delete contact {name}',
    sendMessage: 'Send message',
    voteUp: 'Vote up',
    voteDown: 'Vote down',
    forumRefresh: 'Refresh forum',
    newPost: 'New post',
    forumSettings: 'Forum settings',
    topicSettings: 'Topic settings',
    chatMenu: 'Chat options',
    closeInfo: 'Back to chat',
    exitSelectMode: 'Exit message selection',
    attachmentOptions: 'Attachment options',
    stampPayment: 'Stamp payment',
    messageActions: 'Show message actions',
    replyToMessage: 'Reply to message',
    forwardMessage: 'Forward message',
    messageInfo: 'Message info',
    deleteMessage: 'Delete message',
    resendMessage: 'Resend message',
    cancelReply: 'Cancel reply',
    scrollToLatest: 'Scroll to latest messages',
    copyAddress: 'Copy address',
    connectRelay: 'Connect to relay',
    choosePhoto: 'Choose profile photo',
    previousAvatar: 'Previous avatar',
    nextAvatar: 'Next avatar',
    chooseFile: 'Choose a file',
    openInExplorer: 'Open transaction in block explorer',
  },
  leftDrawer: {
    noForums: 'No forums discovered yet.',
    settings: 'Settings',
    contacts: 'Contacts',
    forum: 'Forum',
    wallet: 'Wallet',
    railLabel: 'Sidebar sections',
    contactsUnreadOne: 'Contacts, {count} unread message',
    contactsUnreadOther: 'Contacts, {count} unread messages',
  },
  walletPanel: {
    title: 'Wallets',
    mainWallet: 'Main wallet',
    monad: 'Monad',
    send: 'Send MON',
    receive: 'Receive MON',
    showSeed: 'Show recovery phrase',
    confirmSeed: 'Confirm recovery phrase',
    balanceLoading: 'Loading balance…',
    balanceUnavailable: 'Balance unavailable. Retrying.',
    balanceStale: '{balance} (last known)',
    failedLoadAddress: 'Failed to load the Monad wallet address',
    unableCopyAddress: 'Unable to copy the Monad address',
  },
  chatList: {
    noContactMessage: 'Add contacts from the drawer above...',
    youPrefix: 'You: {text}',
    themPrefix: 'Them: {text}',
    balance: 'Balance',
    balanceStale: '(last known)',
    directMessages: 'Direct Messages',
  },
  selfChat: {
    you: 'You',
  },
  outgoing: {
    sending: 'Sending…',
    paymentPending:
      'Payment pending, will retry. You will not be charged again.',
    paymentQueued:
      'Waiting for an earlier message to finish. This one will be sent after it.',
    paymentChecking: 'Checking payment status…',
    reasonUnreachable: "Can't reach the server.",
    reasonUnavailable: 'This relay does not offer messaging.',
    reasonRejected: 'The relay rejected it.',
    reasonInterrupted: 'It was interrupted before it was sent.',
    reasonUnverified: 'Delivery could not be confirmed.',
    reasonRecovered: 'An earlier message was delivered meanwhile.',
    reasonInsufficientFunds: 'There are not enough funds to send this message.',
    reasonError: 'The message could not be sent.',
    retry: 'Retry',
    retryHint:
      'Retry re-sends the same payment while it is still valid. A new payment is made only if it is not.',
    discard: 'Discard',
    discardConfirmTitle: 'Discard message?',
    discardConfirmMessage:
      'This removes it from your conversation. If its payment is still pending it may still be delivered.',
    sendAgainTitle: 'Send again?',
    sendAgainUnverified:
      'We could not confirm whether the first payment was delivered. Sending again may charge you a second time.',
    sendAgainRecovered:
      'An earlier pending message was delivered while this one was being sent. Send this one again as a new message?',
    sendAgain: 'Send again',
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
    failedToSend: 'Failed to send',
    showActions: 'Show message actions',
    replyMessage: 'Reply to message',
    forwardMessage: 'Forward message',
    infoMessage: 'Message info',
    deleteMessage: 'Delete message',
  },
  chatMessageMenu: {
    messageCopied: 'Message copied to clipboard',
  },
  notifications: {
    addressCopied: 'Address copied to clipboard.',
    insufficientStamp: 'Stamp is too small, receiver will not be notified.',
    seedCopied: 'Your recovery phrase has been copied to your clipboard.',
    sentTransaction: 'Sent transaction',
    unexpectedError: 'Something went wrong. Please try again.',
    viewAction: 'View',
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
    networkTitle: 'Monad Testnet',
    testnetDisclaimer:
      'Frank runs on the Monad testnet. All transactions use testnet MON, which has no real-world monetary value. Never send real funds or mainnet assets.',
    economicModelTitle: 'Paid Actions & Costs',
    costsDisclaimer:
      'Network and stamp costs apply to outgoing actions. The actual fee or stamp amount is always shown before you confirm an action.',
    directMessagesTitle: 'Direct Messages',
    directMessagesDesc:
      'Paid directly to the recipient as an inbox stamp, preventing spam and compensating delivery.',
    topicActionsTitle: 'Forum Posts & Votes',
    topicActionsDesc:
      'Burned (permanently destroyed on-chain) to publish public topic posts or record votes.',
    fundingTitle: 'Testnet Funding',
    fundingDesc:
      'New accounts receive testnet MON automatically from the demo faucet. You can also view your address and obtain testnet funds from the Receive screen after setup.',
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
      'Write down your recovery phrase and keep it safe. If you lose it, nobody can recover your account.',
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
      'A recovery phrase is already stored on this device, but this account has no name yet. Confirm it and choose a name to finish. It is not replaced unless you import a different phrase you already have.',
    confirmStoredFirst: 'Confirm or copy your stored recovery phrase first.',
    importDifferentPhrase: 'I already have a different recovery phrase',
    importDifferentContinue: 'Continue to import',
    invalidWordCount:
      'A recovery phrase must contain 12, 15, 18, 21, or 24 words.',
    unrecognizedWords: 'One or more words are not recognized. Check for typos.',
    invalidChecksum:
      'The recovery phrase checksum is invalid. Check the order and spelling of your words.',
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
    wordError: 'Word #{n} does not match',
    recheck:
      'Some words do not match your recovery phrase. Re-check these word numbers: {positions}.',
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
    introNameOnly:
      'Setting up again would replace it. This profile does not have a recovery phrase or wallet funds on this device.',
    confirmed: 'Your current recovery phrase is confirmed.',
    cancel: 'Cancel and go back to my account',
    confirmCurrent: 'Confirm my current recovery phrase',
    replaceToggle: 'Replace this account',
    warning:
      'Replacing this account will remove your current recovery phrase, name and profile from this device. If you have not backed the phrase up, the account and any funds may be unrecoverable.',
    warningNameOnly:
      'Replacing this account will remove your current name and profile from this device.',
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
    wipeAndSave: 'Delete relay messages',
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
    failedLoadBalance: 'Failed to load Monad wallet balance',
    unableCopyAddress: 'Unable to copy the Monad address',
  },
  sendAddressDialog: {
    sendToAddress: 'Send to Address',
    enterBitcoinCashAddress: 'Enter address (0x...)',
    enterAmount: 'Enter Amount (MON)',
    cancel: 'Cancel',
    send: 'Send',
    review: 'Review',
    reviewTitle: 'Review Transfer',
    network: 'Network',
    recipient: 'Recipient',
    amount: 'Amount',
    estimatedFee: 'Estimated Fee',
    feeUnavailable: 'Unavailable',
    maxTotal: 'Maximum Total',
    maxTotalWithFee: '{amount} {unit} (+ network fee)',
    irreversibleWarning:
      'Blockchain transactions are irreversible. Verify recipient and network before confirming.',
    editTransfer: 'Edit',
    confirmAndSend: 'Confirm & Send',
    definitelyNotBroadcast:
      'Transaction was not broadcast. No funds were transferred.',
    potentiallyBroadcast:
      'Transaction was signed ({txHash}) and may have been broadcast. Check your balance or transaction status before retrying.',
    invalidTransfer: 'Enter a valid Monad address and MON amount.',
    failedSendTransaction: 'Failed to send Monad transaction',
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
    title: 'Settings',
    back: 'Back',
    openMenu: 'Open the menu',
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
    seedEntry: 'Recovery phrase',
    importSeed: 'Recover past memories',
    invalidSeed: 'That is not a valid recovery phrase.',
    nameHint: 'Name displayed to others',
    enterSeed: 'Enter your recovery phrase...',
    nameBlank: 'Enter a name: it cannot be empty or only spaces.',
    nameTooLong: 'The name is too long: use at most {max} characters.',
    nameForbiddenCharacters:
      'The name contains characters that are not allowed. Remove line breaks and other control characters.',
    nameInvalidUnicode:
      'The name contains an invalid character. Delete it or paste plain text.',
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
    profile: 'Profile',
  },
  wipeWallet: {
    warning: 'Delete all relay messages?',
    warningMsg:
      'This permanently deletes every message stored on the relay server, along with the local copies in this app. Your wallet, seed phrase, and funds are not touched.',
    cannotBeUndone: 'This cannot be undone.',
    cancel: 'Cancel',
    wipe: 'Delete All Messages',
    spinnerText: 'Deleting messages…',
  },
  seedPhraseDialog: {
    seedPhrase: 'Recovery Phrase',
    close: 'Close',
    cancel: 'Cancel',
    warningTitle: 'Security Warning',
    warningBody:
      'Make sure no one is watching your screen. Beware of screen-sharing, shoulder-surfing, screenshots, and clipboard history.',
    disclosureText:
      'Anyone who gets your recovery phrase can access and steal all your funds and messages permanently.',
    revealButton: 'Reveal Recovery Phrase',
    hideButton: 'Hide',
    copyButton: 'Copy',
    copied: 'Copied!',
    copiedToast: 'Recovery phrase copied to clipboard',
    keepPrivateNotice: 'Keep this private. Do not share or screenshot.',
  },
  transactionDialog: {
    backingTransactions: 'Backing Transactions',
    totalStampPayment: 'Total stamp payment',
    stampPaymentN: 'Stamp payment {n}',
    sentTo: 'To {address}',
    txId: 'Transaction ID',
    txType: 'Type',
    txAddress: 'Address',
    txAmount: 'Amount',
  },
  close: 'Close',
}
