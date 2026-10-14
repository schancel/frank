export const en = {
  mera_title: 'Mera',
  mera_choose:
    'Use an existing passkey, or create a new account with a new passkey.',
  mera_existing: 'Use existing passkey',
  mera_new: 'Create new passkey',
  mera_create: 'Create with Mera',
  mera_login: 'Continue with Mera (Passkey)',
  mera_verification_unreachable:
    'Could not verify your existing account. Your passkey account is ready for confirmation; check your connection before continuing.',
  mera_description:
    'A new passkey creates a new Frank account. Log in with your existing passkey to return to the same account on this website. You can also save recovery shares from account backup.',
  mera_unsupported:
    'Passkeys require a secure website and a supported browser. Use account creation or recovery shares instead.',
  mera_cancelled:
    'The passkey request was cancelled or timed out. No account was activated. Try again when ready.',
  mera_prf:
    'This passkey or browser did not provide the required PRF secret. No account was activated. Try a supported passkey provider and browser, or use recovery shares.',
  mera_failed:
    'The passkey request could not finish. No account was activated. Retry with the same passkey. A passkey may have been created before this failure; use existing-passkey login to retry it.',
  wallet_chain_mismatch:
    'This saved wallet does not match the network or account configuration the app is using. Restore the previous network configuration and retry opening the existing account. Its saved data has not been changed.',
  profile_restore_unreachable:
    'Your account was recovered, but its profile could not be fetched. Check the relay connection and retry.',
  profile_restore_retry: 'Retry profile lookup',
  pending_outdated_cancel_and_redo:
    'This attempt was saved by an earlier version of Frank and cannot be activated. Cancel it, then create or restore the account again. The shares you wrote down still restore the account.',
  pending_retry:
    'Pending account cleanup could not finish. Your active account is unchanged. Retry or cancel this attempt before starting another.',
  balance_loading: 'Loading balance…',
  balance_unavailable: 'Balance unavailable. Retrying.',
  balance_stale:
    'Last known balance — refresh failed. This value may be out of date.',
  profile_unavailable:
    'Public profile publishing and direct messaging are not yet available for this account. No legacy directory identity will be published. Your local account name is unchanged.',
  open_navigation: 'Open navigation',
  frank_account: 'Frank account',
  saved_account_data_could_not_be_opened:
    'Saved account data could not be opened. It has not been replaced. This preview requires encrypted browser storage; native apps are not supported.',
  retry_opening_account: 'Retry',
  reset_account_storage: 'Reset storage',
  reset_account_storage_confirm:
    'Resetting damaged storage will clear the unopenable local account data. You can then restore your account from backup shares. Proceed?',
  a_saved_account_attempt_is_pending_it:
    'A saved account attempt is pending. It is not active until you choose Activate account.',
  account_found: 'Confirm identity',
  activate_account: 'Activate',
  pending_identity_address:
    'Activating opens the account with this identity address. Its published profile will be loaded separately:',
  pending_username: 'Username',
  pending_profile_loading: 'Checking the published profile…',
  pending_profile_unreachable:
    'The published profile could not be checked. Verify the relay connection and retry. You can still confirm the identity address.',
  pending_profile_unverified:
    'The returned profile could not be verified for this identity. Check the identity address before activating.',
  pending_identity_stop_if_unexpected:
    'If you are restoring an account and this is not the address you expect, stop: do not activate. Cancel the attempt instead.',
  the_attempt_is_incomplete_or_awaiting_cleanup:
    'The attempt is incomplete or awaiting cleanup. Cancel it explicitly before starting another account.',
  cancel_pending_attempt: 'Cancel',
  create_a_frank_account_backup_or_restore:
    'Create a Frank account and its backup, or restore one from your saved Recovery shares. No funds are required to activate locally.',
  an_existing_legacy_account_is_quarantined_its:
    'An existing legacy account is quarantined. Its saved data remains untouched and is not opened as the normal account.',
  changing_accounts_replaces_the_active_local_account:
    'Changing accounts replaces the active local account after backup confirmation. Keep your existing backup.',
  i_understand_this_changes_the_active_local:
    'I understand this changes the active local identity and does not transfer funds or history.',
  new_account: 'New Account',
  restore_account: 'Restore account',
  legacy_recovery_migration: 'Legacy recovery',
  return_to_wallet: 'Back',
  this_identifies_your_old_account_locally_you:
    'Enter the BIP39 phrase saved for your Frank account. Review its identity address before activating. Your existing profile will be fetched after recovery.',
  legacy_bip39_recovery_phrase: 'Legacy BIP39 recovery phrase',
  identify_legacy_account_locally: 'Restore BIP39 account',
  old_account: 'Old account:',
  the_new_identity_is_different_no_funds:
    '. The new identity is different; no funds, history or remote keys are migrated.',
  choose_how_many_shares_you_must_retain:
    'Choose how many shards you must retain. Losing too many shards loses access permanently. Keep shards in separate safe places; anyone with the threshold can recover the account.',
  generate_frank_account_backups: 'Generate backups',
  frank_account_backup: 'Frank account backup',
  save_each_share_before_moving_on_exactly:
    '. Save each shard before moving on. Exactly',
  consistent_shares_are_required_to_confirm:
    'consistent shards are required to confirm.',
  frank_account_backup_share: 'Frank account backup shard',
  copy_this_share: 'Copy this shard',
  save_two_independent_copies_of_this_public:
    'Save two independent copies of this public account descriptor with your recovery records. It matches a recovered account, but is not self-authenticating evidence of ownership. Use your independently saved copy when restoring.',
  public_frankdesc_descriptor: 'Public frankdesc descriptor',
  copy_public_descriptor: 'Copy public descriptor',
  i_saved_two_independent_copies_of_the:
    'I saved two independent copies of the public descriptor.',
  confirm_my_saved_backups: 'Confirm backups',
  enter_the_public_frankdesc_descriptor_from_an:
    'Enter the public frankdesc descriptor from an independent saved copy first. It is account matching metadata, not self-authenticating proof. Never use a descriptor inferred from the submitted shards.',
  independently_saved_frankdesc_descriptor:
    'Independently saved frankdesc descriptor',
  pin_expected_account: 'Pin expected account',
  re_enter_exactly: 'Re-enter exactly',
  saved_frank_account_backup_shares_we_reconstruct:
    'saved Frank account backup shards. We reconstruct and compare the complete account before staging.',
  enter_at_least_the_threshold_number_of_shares:
    'Enter at least the threshold number printed in your backup, one shard per line. Extra shards from the same backup let the app detect a wrong one and tell you which.',
  share_report_title: 'What the app found in the shards you entered:',
  share_report_supports: 'Shard {n} (index {index}): used.',
  share_report_inconsistent:
    'Shard {n} (index {index}): does not belong to this backup. It is wrong or damaged.',
  share_report_different_set:
    'Shard {n} (set {identifier}): from a different backup set.',
  share_report_duplicate: 'Shard {n}: entered more than once.',
  share_report_invalid:
    'Shard {n}: could not be read. Check it for a typing error.',
  restore_choose_explained:
    'These shards contain complete backups of more than one account. Frank will not choose for you. If you did not expect this, someone may have given you shards of an account they control. Restore only the address you recognise.',
  restore_choose_identity: 'Account with this identity address:',
  restore_choose_shares: 'Built from shards {shares}.',
  restore_choose_pick: 'Restore this account',
  expected_account: 'Expected account:',
  insufficient_share_set:
    'Backup {identifier}: {available} distinct shards available; {required} required.',
  saved_codex32_shares_one_per_line: 'Saved recovery shards, one per line',
  display_name: 'Display name',
  display_name_required:
    'Required. This is the name people you message will see; you can change it later in your profile.',
  verify_backups_and_stage_account: 'Verify backups and stage account',
  cancel_and_start_again: 'Cancel',
  browser_preview_encrypted_local_storage_does_not:
    'Browser preview: encrypted local storage does not protect against malicious code in this origin or theft of the whole browser profile. Keep independent backups. Clearing local data can remove access.',
  messaging_is_unavailable_for_typed_accounts_in:
    'Messaging is unavailable for typed accounts in this preview.',
  main_wallet: 'Main wallet',
  frank_account_recovery: 'Frank account recovery',
  backup_shares_were_verified_before_activation_keep:
    'Backup shards were verified before activation. Keep your saved copies safe. Resident domain roots cannot recreate the original master or backup shards.',
  public_recovery_descriptor: 'Public recovery descriptor',
  fingerprint: 'Fingerprint:',
  create_or_restore_account: 'Create or restore account',
  frank_account_backups_were_verified_before_activation:
    'Frank account backups were verified before activation. Keep the saved shards and public descriptor; this device cannot recreate the original backup shards.',
  browser_storage: 'Browser storage',
  browser_persistence_reduces_automatic_eviction_it_is:
    'Browser persistence reduces automatic eviction. It is not a backup or protection against malicious code or a stolen browser profile.',
  request_persistent_storage: 'Request persistent storage',
  keep_independent_account_backup:
    'Keep an independent backup of your account. Browser storage protection is not a backup.',
  import_bip39_seed: 'Import BIP39 seed',
  not_backed_up_tooltip:
    "You haven't backed up your wallet or identity yet. Tap to back up now.",
  backup_account_codex32: 'Backup account',
  codex32_threshold_explainer:
    'Write down each shard. Any {threshold} of these {count} shards restore the original account secret and its derivation.',
  codex32_backup_sets_do_not_mix:
    'This is a new set. Shards from different sets, including the ones shown when the account was created, cannot be combined. Changing the scheme or reopening this page makes a different set, so finish writing this one down first.',
  cancel_scheme: 'Cancel',
  recovery_shares_privacy:
    'Anyone who sees these shards can take this account. Make sure nobody else can see your screen.',
  codex32_backup_unavailable_for_account:
    'The original secret needed to issue backup shards is unavailable on this device. Your existing backup remains valid.',
  historical_share_keep_both_lines:
    'Keep the Seed and Check lines together as one paper shard. Enter both lines together when restoring.',
  backup_seed_line: 'Seed',
  backup_check_line: 'Check',
  configure_scheme: 'Configure threshold and shards',
  custom_threshold_shares: 'Custom threshold and shards',
  threshold: 'Threshold',
  total_shares: 'Total shards',
  apply: 'Apply',
  generating_codex32_backup_shares: 'Generating recovery shards…',
  share: 'Shard',
  copy_share: 'Copy',
  verify_shards_title: 'Verify shards',
  verify_shards_explainer:
    'Test your saved shards by entering at least the threshold number to verify they reconstruct your account.',
  verify_shards_button: 'Verify shards',
  verify_shards_clear: 'Clear',
  verify_shards_success: 'Shards verified successfully! Your backup is valid.',
  advanced_details: 'Advanced details',
  advanced_options: 'Advanced options',
  relay_server: 'Relay server',
  relay_server_url: 'Relay Server URL',
  relay_server_url_hint:
    'Home relay server for your encrypted mailbox and profile',
  reset_to_default_relay: 'Reset to default relay',
  invalid_relay_url: 'Please enter a valid HTTP or HTTPS URL',
  relay_discovered:
    'Discovered existing home relay: {url}. Automatically configured.',
  frank_is_open_in_another_tab: 'Frank is open in another tab',
  multi_tab_notice:
    'Your account is still saved on this device. Frank is active in another tab or window. To protect your wallet, only one can use the account at a time. Choose “Use Frank here” to continue here and pause the other tab.',
  use_frank_here: 'Use Frank here',
  switch_to_open_tab: 'Find open Frank tab',
  find_tab_waiting: 'Contacting your open Frank tab…',
  find_tab_focused:
    'Your open Frank tab responded. If it did not appear, select it in your browser.',
  find_tab_notified:
    'A notification was sent from your open Frank tab. Click it to return there. If it does not appear, select the tab in your browser.',
  find_tab_manual:
    'Your open Frank tab responded, but the browser could not switch to it automatically.',
  find_tab_unavailable:
    'Your open Frank tab did not respond. It may be suspended by your browser.',
  find_tab_idle: 'Find your open Frank tab or choose “Use Frank here”.',
  find_tab_notification_title: 'Your open Frank tab',
  find_tab_notification_body:
    'Click this notification to return to the Frank tab using your account.',
  manual_tab_switch_hint:
    'Select the Frank tab in your browser’s tab bar or tab overview. If you cannot find it, choose “Use Frank here” to move your account to this tab.',
  tab_yielded_notice: 'Frank is active in another tab or window.',
}

export const fr = {
  mera_title: 'Mera',
  mera_choose:
    'Utilisez une clé d’accès existante ou créez un nouveau compte avec une nouvelle clé.',
  mera_existing: 'Utiliser une clé existante',
  mera_new: 'Créer une nouvelle clé',
  mera_create: 'Créer avec Mera',
  mera_login: 'Continuer avec Mera (clé d’accès)',
  mera_verification_unreachable:
    'Impossible de vérifier votre compte existant. Votre compte est prêt à être confirmé ; vérifiez votre connexion avant de continuer.',
  mera_description:
    'Une nouvelle clé d’accès crée un nouveau compte Frank. Connectez-vous avec votre clé existante pour retrouver le même compte sur ce site. Vous pouvez aussi enregistrer des parts de récupération dans la sauvegarde du compte.',
  mera_unsupported:
    'Les clés d’accès nécessitent un site sécurisé et un navigateur compatible. Utilisez la création de compte ou les parts de récupération.',
  mera_cancelled:
    'La demande de clé d’accès a été annulée ou a expiré. Aucun compte n’a été activé. Réessayez lorsque vous êtes prêt.',
  mera_prf:
    'Cette clé d’accès ou ce navigateur n’a pas fourni le secret PRF requis. Aucun compte n’a été activé. Essayez un fournisseur et un navigateur compatibles, ou utilisez les parts de récupération.',
  mera_failed:
    'La demande de clé d’accès n’a pas abouti. Aucun compte n’a été activé. Réessayez avec la même clé. Une clé a peut-être été créée avant cet échec ; réessayez avec la connexion par clé existante.',
  wallet_chain_mismatch:
    'Ce portefeuille enregistré ne correspond pas au réseau ou à la configuration de compte utilisé par l’application. Rétablissez la configuration réseau précédente puis réessayez d’ouvrir le compte existant. Les données enregistrées n’ont pas été modifiées.',
  profile_restore_unreachable:
    'Votre compte a été récupéré, mais son profil n’a pas pu être chargé. Vérifiez la connexion au relais et réessayez.',
  profile_restore_retry: 'Réessayer de charger le profil',
  pending_outdated_cancel_and_redo:
    'Cette tentative a été enregistrée par une version antérieure de Frank et ne peut pas être activée. Annulez-la, puis créez ou restaurez le compte à nouveau. Les parts que vous avez notées restaurent toujours le compte.',
  pending_retry:
    'Le nettoyage du compte en attente a échoué. Le compte actif est inchangé. Réessayez ou annulez cette tentative avant d’en commencer une autre.',
  balance_loading: 'Chargement du solde…',
  balance_unavailable: 'Solde indisponible. Nouvelle tentative.',
  balance_stale:
    'Dernier solde connu — l’actualisation a échoué. Cette valeur peut être périmée.',
  profile_unavailable:
    'La publication du profil et la messagerie directe ne sont pas encore disponibles pour ce compte. Aucune identité ne sera publiée dans l’ancien annuaire. Le nom local du compte reste inchangé.',
  open_navigation: 'Ouvrir la navigation',
  frank_account: 'Compte Frank',
  saved_account_data_could_not_be_opened:
    'Impossible d’ouvrir les données enregistrées du compte. Elles n’ont pas été remplacées. Cet aperçu nécessite le stockage chiffré du navigateur ; les applications natives ne sont pas prises en charge.',
  retry_opening_account: 'Réessayer',
  reset_account_storage: 'Réinitialiser le stockage',
  reset_account_storage_confirm:
    'La réinitialisation effacera les données de compte local illisibles. Vous pourrez ensuite restaurer votre compte depuis vos clés de secours. Continuer ?',
  a_saved_account_attempt_is_pending_it:
    'Une tentative de création enregistrée est en attente. Le compte ne sera actif qu’après avoir choisi Activer le compte.',
  account_found: 'Confirmer l’identité',
  activate_account: 'Activer',
  pending_identity_address:
    'L’activation ouvre le compte ayant cette adresse d’identité. Son profil publié sera chargé séparément :',
  pending_username: 'Identifiant',
  pending_profile_loading: 'Vérification du profil publié…',
  pending_profile_unreachable:
    'Le profil publié n’a pas pu être vérifié. Vérifiez la connexion au relais et réessayez. Vous pouvez toujours confirmer l’adresse d’identité.',
  pending_profile_unverified:
    'Le profil reçu n’a pas pu être vérifié pour cette identité. Vérifiez l’adresse avant de l’activer.',
  pending_identity_stop_if_unexpected:
    'Si vous restaurez un compte et que ce n’est pas l’adresse attendue, arrêtez : n’activez pas. Annulez plutôt la tentative.',
  the_attempt_is_incomplete_or_awaiting_cleanup:
    'La tentative est incomplète ou en attente de nettoyage. Annulez-la explicitement avant de créer un autre compte.',
  cancel_pending_attempt: 'Annuler',
  create_a_frank_account_backup_or_restore:
    'Créez un compte Frank et sa sauvegarde, ou restaurez-en un avec vos parts de récupération enregistrées. Aucun fonds n’est nécessaire pour l’activation locale.',
  an_existing_legacy_account_is_quarantined_its:
    'Un ancien compte est en quarantaine. Ses données enregistrées restent intactes et ne sont pas ouvertes comme compte courant.',
  changing_accounts_replaces_the_active_local_account:
    'Changer de compte remplace le compte local actif après confirmation des sauvegardes. Conservez votre sauvegarde existante.',
  i_understand_this_changes_the_active_local:
    'Je comprends que cela change l’identité locale active et ne transfère ni fonds ni historique.',
  new_account: 'Nouveau compte',
  restore_account: 'Restaurer un compte',
  legacy_recovery_migration: 'Récupération',
  return_to_wallet: 'Retour',
  this_identifies_your_old_account_locally_you:
    'Entrez la phrase BIP39 enregistrée pour votre compte Frank. Vérifiez son adresse avant l’activation. Votre profil existant sera chargé après la récupération.',
  legacy_bip39_recovery_phrase:
    'Phrase de récupération BIP39 de l’ancien compte',
  identify_legacy_account_locally: 'Restaurer un compte BIP39',
  old_account: 'Ancien compte :',
  the_new_identity_is_different_no_funds:
    '. La nouvelle identité est différente ; aucun fonds, historique ou clé distante n’est migré.',
  choose_how_many_shares_you_must_retain:
    'Choisissez combien de parts conserver. La perte d’un trop grand nombre de parts entraîne la perte définitive de l’accès. Conservez-les dans des lieux sûrs distincts ; toute personne possédant le seuil requis peut récupérer le compte.',
  generate_frank_account_backups: 'Générer les sauvegardes',
  frank_account_backup: 'Sauvegarde du compte Frank',
  save_each_share_before_moving_on_exactly:
    '. Enregistrez chaque part avant de continuer. Exactement',
  consistent_shares_are_required_to_confirm:
    'parts cohérentes sont nécessaires à la confirmation.',
  frank_account_backup_share: 'Part de sauvegarde du compte Frank',
  copy_this_share: 'Copier cette part',
  save_two_independent_copies_of_this_public:
    'Enregistrez deux copies indépendantes de ce descripteur public avec vos documents de récupération. Il permet de comparer le compte récupéré, mais ne prouve pas à lui seul sa propriété. Utilisez votre copie indépendante lors de la restauration.',
  public_frankdesc_descriptor: 'Descripteur public frankdesc',
  copy_public_descriptor: 'Copier le descripteur public',
  i_saved_two_independent_copies_of_the:
    'J’ai enregistré deux copies indépendantes du descripteur public.',
  confirm_my_saved_backups: 'Confirmer mes sauvegardes',
  enter_the_public_frankdesc_descriptor_from_an:
    'Saisissez d’abord le descripteur public frankdesc depuis une copie enregistrée indépendante. Ces métadonnées servent à comparer le compte, sans constituer une preuve autonome. N’utilisez jamais un descripteur déduit des parts soumises.',
  independently_saved_frankdesc_descriptor:
    'Descripteur frankdesc enregistré indépendamment',
  pin_expected_account: 'Fixer le compte attendu',
  re_enter_exactly: 'Saisissez à nouveau exactement',
  saved_frank_account_backup_shares_we_reconstruct:
    'parts de sauvegarde enregistrées du compte Frank. Le compte complet est reconstruit et comparé avant sa préparation.',
  enter_at_least_the_threshold_number_of_shares:
    'Saisissez au moins le nombre seuil indiqué sur votre sauvegarde, une part par ligne. Des parts supplémentaires de la même sauvegarde permettent à l’application de détecter une part erronée et de vous dire laquelle.',
  share_report_title: 'Ce que l’application a trouvé dans les parts saisies :',
  share_report_supports: 'Part {n} (index {index}) : utilisée.',
  share_report_inconsistent:
    'Part {n} (index {index}) : n’appartient pas à cette sauvegarde. Elle est erronée ou endommagée.',
  share_report_different_set:
    'Part {n} (jeu {identifier}) : provient d’un autre jeu de sauvegarde.',
  share_report_duplicate: 'Part {n} : saisie plusieurs fois.',
  share_report_invalid:
    'Part {n} : illisible. Vérifiez qu’elle ne contient pas de faute de frappe.',
  restore_choose_explained:
    'Ces parts contiennent les sauvegardes complètes de plusieurs comptes. Frank ne choisira pas à votre place. Si vous ne vous y attendiez pas, quelqu’un vous a peut-être remis des parts d’un compte qu’il contrôle. Ne restaurez que l’adresse que vous reconnaissez.',
  restore_choose_identity: 'Compte ayant cette adresse d’identité :',
  restore_choose_shares: 'Construit à partir des parts {shares}.',
  restore_choose_pick: 'Restaurer ce compte',
  expected_account: 'Compte attendu :',
  insufficient_share_set:
    'Sauvegarde {identifier} : {available} parts distinctes disponibles ; {required} requises.',
  saved_codex32_shares_one_per_line:
    'Parts de récupération enregistrées, une par ligne',
  display_name: 'Nom affiché',
  display_name_required:
    'Obligatoire. C’est le nom que verront les personnes à qui vous écrivez ; vous pourrez le modifier plus tard dans votre profil.',
  verify_backups_and_stage_account:
    'Vérifier les sauvegardes et préparer le compte',
  cancel_and_start_again: 'Annuler',
  browser_preview_encrypted_local_storage_does_not:
    'Aperçu dans le navigateur : le stockage local chiffré ne protège pas contre le code malveillant de cette origine ni le vol du profil complet du navigateur. Conservez des sauvegardes indépendantes. Effacer les données locales peut supprimer l’accès.',
  messaging_is_unavailable_for_typed_accounts_in:
    'La messagerie est indisponible pour les comptes typés dans cet aperçu.',
  main_wallet: 'Portefeuille principal',
  frank_account_recovery: 'Récupération du compte Frank',
  backup_shares_were_verified_before_activation_keep:
    'Les parts de sauvegarde ont été vérifiées avant l’activation. Gardez vos copies en sécurité. Les racines de domaine stockées ne permettent pas de recréer le secret maître ni les parts d’origine.',
  public_recovery_descriptor: 'Descripteur public de récupération',
  fingerprint: 'Empreinte :',
  create_or_restore_account: 'Créer ou restaurer un compte',
  frank_account_backups_were_verified_before_activation:
    'Les sauvegardes du compte Frank ont été vérifiées avant l’activation. Conservez les parts et le descripteur public ; cet appareil ne peut pas recréer les parts d’origine.',
  browser_storage: 'Stockage du navigateur',
  browser_persistence_reduces_automatic_eviction_it_is:
    'La persistance du navigateur réduit l’effacement automatique. Ce n’est ni une sauvegarde ni une protection contre le code malveillant ou le vol du profil du navigateur.',
  request_persistent_storage: 'Demander le stockage persistant',
  keep_independent_account_backup:
    'Conservez une sauvegarde indépendante de votre compte. La protection du stockage du navigateur ne remplace pas une sauvegarde.',
  import_bip39_seed: 'Importer la graine BIP39',
  not_backed_up_tooltip:
    "Vous n'avez pas encore sauvegardé votre portefeuille ou identité. Appuyez pour sauvegarder maintenant.",
  backup_account_codex32: 'Sauvegarder le compte',
  codex32_threshold_explainer:
    'Notez chaque part papier. N’importe quelles {threshold} de ces {count} parts restaurent ce compte : la même identité, les mêmes adresses et les mêmes fonds.',
  codex32_backup_sets_do_not_mix:
    'Ceci est un nouveau jeu de parts. Les parts de jeux différents, y compris celles affichées à la création du compte, ne peuvent pas être combinées. Changer le schéma ou rouvrir cette page crée un jeu différent : terminez d’abord de noter celui-ci.',
  cancel_scheme: 'Annuler',
  recovery_shares_privacy:
    'Quiconque voit ces parts peut s’emparer de ce compte. Assurez-vous que personne d’autre ne voit votre écran.',
  codex32_backup_unavailable_for_account:
    'Le secret d’origine nécessaire pour créer des parts de sauvegarde est indisponible sur cet appareil. Votre sauvegarde existante reste valide.',
  historical_share_keep_both_lines:
    'Conservez les lignes Graine et Vérification ensemble comme une seule part papier. Saisissez les deux lignes ensemble lors de la restauration.',
  backup_seed_line: 'Graine',
  backup_check_line: 'Vérification',
  configure_scheme: 'Configurer le seuil et les parts',
  custom_threshold_shares: 'Seuil et parts personnalisés',
  threshold: 'Seuil',
  total_shares: 'Nombre de parts',
  apply: 'Appliquer',
  generating_codex32_backup_shares: 'Génération des parts de récupération…',
  share: 'Part',
  copy_share: 'Copier',
  verify_shards_title: 'Vérifier les parts',
  verify_shards_explainer:
    'Testez vos parts enregistrées en saisissant au moins le nombre seuil pour vérifier qu’elles permettent de reconstituer votre compte.',
  verify_shards_button: 'Vérifier les parts',
  verify_shards_clear: 'Effacer',
  verify_shards_success:
    'Parts vérifiées avec succès ! Votre sauvegarde est valide.',
  advanced_details: 'Détails avancés',
  advanced_options: 'Options avancées',
  relay_server: 'Serveur relais',
  relay_server_url: 'URL du serveur relais',
  relay_server_url_hint:
    'Serveur relais principal pour votre boîte aux lettres chiffrée et profil',
  reset_to_default_relay: 'Réinitialiser au relais par défaut',
  invalid_relay_url: 'Veuillez saisir une URL HTTP ou HTTPS valide',
  relay_discovered:
    'Serveur relais principal existant découvert : {url}. Configuré automatiquement.',
  frank_is_open_in_another_tab: 'Frank est ouvert dans un autre onglet',
  multi_tab_notice:
    'Votre compte est toujours enregistré sur cet appareil. Frank est actif dans un autre onglet ou une autre fenêtre. Pour protéger votre portefeuille, un seul peut utiliser le compte à la fois. Choisissez « Utiliser Frank ici » pour continuer ici et mettre l’autre onglet en pause.',
  use_frank_here: 'Utiliser Frank ici',
  switch_to_open_tab: 'Retrouver l’onglet Frank ouvert',
  find_tab_waiting: 'Recherche de votre onglet Frank ouvert…',
  find_tab_focused:
    'Votre onglet Frank ouvert a répondu. S’il ne s’affiche pas, sélectionnez-le dans votre navigateur.',
  find_tab_notified:
    'Une notification a été envoyée depuis votre onglet Frank ouvert. Cliquez dessus pour y revenir. Si elle ne s’affiche pas, sélectionnez l’onglet dans votre navigateur.',
  find_tab_manual:
    'Votre onglet Frank ouvert a répondu, mais le navigateur n’a pas pu l’afficher automatiquement.',
  find_tab_unavailable:
    'Votre onglet Frank ouvert n’a pas répondu. Il est peut-être suspendu par votre navigateur.',
  find_tab_idle:
    'Retrouvez votre onglet Frank ouvert ou choisissez « Utiliser Frank ici ».',
  find_tab_notification_title: 'Votre onglet Frank ouvert',
  find_tab_notification_body:
    'Cliquez sur cette notification pour revenir à l’onglet Frank qui utilise votre compte.',
  manual_tab_switch_hint:
    'Sélectionnez l’onglet Frank dans la barre d’onglets ou la vue d’ensemble du navigateur. Si vous ne le trouvez pas, choisissez « Utiliser Frank ici » pour déplacer votre compte vers cet onglet.',
  tab_yielded_notice:
    'Frank est actif dans un autre onglet ou une autre fenêtre.',
}
