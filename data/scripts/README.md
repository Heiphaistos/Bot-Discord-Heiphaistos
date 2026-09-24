# Scripts HeiphaisBot

Déposez ici les scripts que le propriétaire du bot pourra lancer depuis Discord,
le panel web ou la CLI avec `/sys script run <nom> [arguments]`.

Extensions reconnues et interpréteurs utilisés :
- `.sh`  → bash (ou sh)
- `.ps1` → pwsh (PowerShell, si installé)
- `.py`  → python3
- `.js`  → node (même binaire que le bot)

Règles de sécurité :
- seuls les fichiers présents dans ce dossier sont exécutables (aucun chemin, aucune commande libre) ;
- les arguments ne peuvent pas contenir ; | & $ ` > < \ ( ) { } ni de retour à la ligne ;
- les scripts sont lancés sans shell intermédiaire, avec ce dossier comme répertoire courant ;
- un délai maximal (paramètre `scriptTimeout` du module sysadmin) interrompt les scripts trop longs ;
- chaque exécution est journalisée (table `sa_script_runs`).
