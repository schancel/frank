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
    'Choose how many shares you must retain. Losing too many shares loses access permanently. Keep shares in separate safe places; anyone with the threshold can recover the account.',
  generate_frank_account_backups: 'Generate backups',
  frank_account_backup: 'Frank account backup',
  save_each_share_before_moving_on_exactly:
    '. Save each share before moving on. Exactly',
  consistent_shares_are_required_to_confirm:
    'consistent shares are required to confirm.',
  frank_account_backup_share: 'Frank account backup share',
  copy_this_share: 'Copy this share',
  save_two_independent_copies_of_this_public:
    'Save two independent copies of this public account descriptor with your recovery records. It matches a recovered account, but is not self-authenticating evidence of ownership. Use your independently saved copy when restoring.',
  public_frankdesc_descriptor: 'Public frankdesc descriptor',
  copy_public_descriptor: 'Copy public descriptor',
  i_saved_two_independent_copies_of_the:
    'I saved two independent copies of the public descriptor.',
  confirm_my_saved_backups: 'Confirm backups',
  enter_the_public_frankdesc_descriptor_from_an:
    'Enter the public frankdesc descriptor from an independent saved copy first. It is account matching metadata, not self-authenticating proof. Never use a descriptor inferred from the submitted shares.',
  independently_saved_frankdesc_descriptor:
    'Independently saved frankdesc descriptor',
  pin_expected_account: 'Pin expected account',
  re_enter_exactly: 'Re-enter exactly',
  saved_frank_account_backup_shares_we_reconstruct:
    'saved Frank account backup shares. We reconstruct and compare the complete account before staging.',
  enter_at_least_the_threshold_number_of_shares:
    'Enter at least the threshold number printed in your backup, one share per line. Extra shares from the same backup let the app detect a wrong one and tell you which.',
  share_report_title: 'What the app found in the shares you entered:',
  share_report_supports: 'Share {n} (index {index}): used.',
  share_report_inconsistent:
    'Share {n} (index {index}): does not belong to this backup. It is wrong or damaged.',
  share_report_different_set:
    'Share {n} (set {identifier}): from a different backup set.',
  share_report_duplicate: 'Share {n}: entered more than once.',
  share_report_invalid:
    'Share {n}: could not be read. Check it for a typing error.',
  restore_choose_explained:
    'These shares contain complete backups of more than one account. Frank will not choose for you. If you did not expect this, someone may have given you shares of an account they control. Restore only the address you recognise.',
  restore_choose_identity: 'Account with this identity address:',
  restore_choose_shares: 'Built from shares {shares}.',
  restore_choose_pick: 'Restore this account',
  expected_account: 'Expected account:',
  insufficient_share_set:
    'Backup {identifier}: {available} distinct shares available; {required} required.',
  saved_codex32_shares_one_per_line: 'Saved recovery shares, one per line',
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
    'Backup shares were verified before activation. Keep your saved copies safe. Resident domain roots cannot recreate the original master or backup shares.',
  public_recovery_descriptor: 'Public recovery descriptor',
  fingerprint: 'Fingerprint:',
  create_or_restore_account: 'Create or restore account',
  frank_account_backups_were_verified_before_activation:
    'Frank account backups were verified before activation. Keep the saved shares and public descriptor; this device cannot recreate the original backup shares.',
  browser_storage: 'Browser storage',
  browser_persistence_reduces_automatic_eviction_it_is:
    'Browser persistence reduces automatic eviction. It is not a backup or protection against malicious code or a stolen browser profile.',
  request_persistent_storage: 'Request persistent storage',
  keep_independent_account_backup:
    'Keep an independent backup of your account. Browser storage protection is not a backup.',
  import_bip39_seed: 'Import BIP39 seed',
  backup_account_codex32: 'Backup account',
  codex32_threshold_explainer:
    'Write down each share. Any {threshold} of these {count} shares restore the original account secret and its derivation.',
  codex32_backup_sets_do_not_mix:
    'This is a new set. Shares from different sets, including the ones shown when the account was created, cannot be combined. Changing the scheme or reopening this page makes a different set, so finish writing this one down first.',
  cancel_scheme: 'Cancel',
  recovery_shares_privacy:
    'Anyone who sees these shares can take this account. Make sure nobody else can see your screen.',
  codex32_backup_unavailable_for_account:
    'The original secret needed to issue backup shares is unavailable on this device. Your existing backup remains valid.',
  historical_share_keep_both_lines:
    'Keep the Seed and Check lines together as one paper share. Enter both lines together when restoring.',
  backup_seed_line: 'Seed',
  backup_check_line: 'Check',
  configure_scheme: 'Configure threshold and shares',
  custom_threshold_shares: 'Custom threshold and shares',
  threshold: 'Threshold',
  total_shares: 'Total shares',
  apply: 'Apply',
  generating_codex32_backup_shares: 'Generating recovery shares…',
  share: 'Share',
  copy_share: 'Copy',
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
    'To protect your wallet and prevent conflicting transactions, only one tab can access your account at a time.',
  use_frank_here: 'Use Frank here',
  switch_to_open_tab: 'Switch to open tab',
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
    'Pour protéger votre portefeuille et éviter les transactions contradictoires, un seul onglet peut accéder à votre compte à la fois.',
  use_frank_here: 'Utiliser Frank ici',
  switch_to_open_tab: 'Basculer vers l’onglet ouvert',
  tab_yielded_notice:
    'Frank est actif dans un autre onglet ou une autre fenêtre.',
}
