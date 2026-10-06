# clemsupp Twitch moderation dashboard

Ce petit serveur privé enregistre les bans, timeouts et unbans de la chaîne Twitch connectée. Il conserve le nom du modérateur, la personne sanctionnée, l’action, la durée quand Twitch la fournit, la raison, la date et l’origine de l’enregistrement. Les jetons OAuth Twitch sont chiffrés avant d’être enregistrés dans PostgreSQL.

## Ce que l’import initial peut récupérer

Après la connexion Twitch, le serveur importe la liste des sanctions **encore actives** renvoyée par Twitch. Twitch ne fournit pas par cette API l’historique complet des sanctions déjà terminées. Les nouveaux événements seront reçus par EventSub après la création des abonnements. Le compte Twitch connecté doit être **le propriétaire de la chaîne** pour que l’import initial de ses sanctions fonctionne.

## À préparer

1. Une application Twitch créée dans le [Twitch Developer Console](https://dev.twitch.tv/console/apps). Choisis **Confidential** et ajoute comme OAuth Redirect URL exactement `https://TON-SERVICE.onrender.com/auth/callback` après avoir créé le service Render. Garde le Client ID et le Client Secret privés.
2. Une base PostgreSQL accessible au service Render. La base PostgreSQL gratuite de Render expire au bout de 30 jours et ne convient donc qu’à un essai temporaire. Avant cette date, migre les données vers un PostgreSQL durable ou passe la base en payant.
3. Trois valeurs secrètes aléatoires. Elles peuvent être générées sur ton ordinateur avec Node.js :

   ```powershell
   node -e "console.log('ADMIN_PASSWORD=' + require('crypto').randomBytes(24).toString('base64url')); console.log('TOKEN_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex')); console.log('EVENTSUB_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
   ```

   Garde ces valeurs dans un endroit privé. Ajoute-les dans Render, jamais dans un fichier que tu envoies sur GitHub.

## Déposer les fichiers dans GitHub avec GitHub Desktop

1. Télécharge et ouvre GitHub Desktop depuis [desktop.github.com](https://desktop.github.com/), puis connecte-toi au compte GitHub qui possède `clemsupp-moderation-dashboard`.
2. Dans GitHub Desktop, choisis **File > Clone repository…**, sélectionne l’onglet GitHub.com, puis `clemsupp-moderation-dashboard` et **Clone**.
3. Décompresse le dossier livré `clemsupp-moderation-dashboard`. Copie **son contenu** (y compris `.gitignore` et `.env.example`) dans le dossier local du dépôt cloné. Confirme le remplacement uniquement si Windows le demande pour les mêmes fichiers.
4. Dans GitHub Desktop, écris comme résumé `Add Twitch moderation dashboard`, puis clique **Commit to main** et **Push origin**.
5. Sur GitHub, actualise le dépôt et vérifie que `server.js`, `package.json`, `README.md` et `.gitignore` apparaissent à la racine. Le fichier `.env.example` ne contient que des exemples, aucun secret réel.

## Créer PostgreSQL sur Render

1. Dans Render, ouvre **New + > PostgreSQL**.
2. Choisis un nom, la même région que le service web (Oregon si tu as gardé Oregon), puis le plan **Free** pour un essai. Crée la base.
3. Sur la page de la base, copie l’**Internal Database URL** (pas le mot de passe seul). Le lien est un secret : ne le publie pas et ne le colle pas dans le chat.

## Déployer le service web déjà configuré

1. Reviens à l’écran **New Web Service** de Render. Garde le dépôt `clemsupp-moderation-dashboard`, la branche `main`, la commande de construction `npm install`, la commande de démarrage `npm start` et le plan Free.
2. Dans **Environment Variables**, ajoute ces clés une par une :

   | Key | Value |
   | --- | --- |
   | `TWITCH_CLIENT_ID` | Client ID de ton application Twitch |
   | `TWITCH_CLIENT_SECRET` | Client Secret de ton application Twitch |
   | `APP_BASE_URL` | URL publique Render du service, par ex. `https://clemsupp-moderation-dashboard.onrender.com` |
   | `DATABASE_URL` | Internal Database URL de PostgreSQL Render |
   | `ADMIN_PASSWORD` | Valeur générée pour `ADMIN_PASSWORD` |
   | `TOKEN_ENCRYPTION_KEY` | Valeur générée pour `TOKEN_ENCRYPTION_KEY` |
   | `EVENTSUB_SECRET` | Valeur générée pour `EVENTSUB_SECRET` |
   | `NODE_ENV` | `production` |

3. Vérifie que `APP_BASE_URL` n’a pas de `/` final. Clique **Deploy Web Service**.
4. Lorsque Render indique que le service est en ligne, copie son URL. Si elle diffère de la valeur `APP_BASE_URL` ajoutée avant le déploiement, modifie cette variable dans **Environment > Environment Variables** et laisse Render redéployer.
5. Dans Twitch Developer Console, vérifie que **OAuth Redirect URL** correspond exactement à `APP_BASE_URL` suivi de `/auth/callback`.
6. Ouvre `APP_BASE_URL` dans ton navigateur, clique **Connecter Twitch**, puis connecte-toi au compte propriétaire de la chaîne et accepte les permissions.
7. À la fin, le serveur importe les sanctions actives et crée les abonnements Twitch pour les nouveaux bans/timeouts/unbans. Ouvre `/dashboard`; saisis `admin` comme nom d’utilisateur et la valeur `ADMIN_PASSWORD` comme mot de passe.

## Informations utiles

- Le service utilise `channel:moderate` pour recevoir les nouveaux événements et `moderator:read:banned_users` pour importer les sanctions actives.
- Twitch n’envoie pas rétroactivement les événements qui ont eu lieu avant l’abonnement. Ils ne seront présents que si la liste actuelle des sanctions les expose encore.
- Le tableau affiche les 500 événements les plus récents. `/api/events?limit=100` fournit les événements en JSON (limite maximale : 500) et demande le même mot de passe administrateur.
- Le plan web gratuit Render s’endort après inactivité. La première ouverture peut prendre un peu de temps. L’enregistrement en base est persistant tant que la base PostgreSQL reste active.
- Si le Client Secret, `DATABASE_URL`, `ADMIN_PASSWORD`, `TOKEN_ENCRYPTION_KEY` ou `EVENTSUB_SECRET` est exposé, remplace-le dans Twitch/Render. Ne partage pas de capture qui le montre.

## Variables d’environnement requises

`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `APP_BASE_URL`, `DATABASE_URL`, `ADMIN_PASSWORD`, `TOKEN_ENCRYPTION_KEY` et `EVENTSUB_SECRET`.
