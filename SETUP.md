# Setting up Shared Planner

How to put the planner on Cloudflare and sign in for the first time. For
local development see README.md.

Steps marked **(unverified)** have not yet been tried on a real Cloudflare
account. They follow Cloudflare's documentation or wrangler's source and may
need small adjustments; please correct this file when you have done them.

## 1. What gets created

You create nothing by hand. `wrangler.jsonc` names the resources, and the
first deploy creates whatever is missing:

| Binding | Resource | Name |
|---|---|---|
| `DB` | D1 database | `projectplanner` |
| `AUDIO` | R2 bucket | `projectplanner-audio` |
| `MCP_OBJECT` | Durable Object class `PlannerMcp` (part of the Worker) | — |

Later deploys find the database and the bucket again by name.

**(unverified)** If R2 has never been used on the Cloudflare account, the
first deploy may stop with a message that R2 must be enabled. Turn on R2 in
the dashboard (R2 Object Storage) and deploy again.

## 2. Deploying

`npm run deploy` (`scripts/deploy.sh`) applies the D1 migrations and then
deploys the Worker; `wrangler deploy` builds the app (Vite) first. On the very
first deploy the database does not exist yet, so the script deploys first,
which creates it, and applies the migrations straight after. (Checked against
wrangler 4.151's behaviour; the first deploy itself is **(unverified)**.)

### From Git with Cloudflare's build settings

In the Cloudflare dashboard, connect the repository to a Worker
(Workers & Pages → Create → import a repository) **(unverified: menu names)**
and use these build settings:

| Setting | Value |
|---|---|
| Build command | `npm run build` (optional: it checks that the app and the Worker build without deploying; the deploy builds again anyway) |
| Deploy command | `npm run deploy` (migrations, then deploy) |
| Root directory | the repository root |

**(unverified)** The Worker's name in the dashboard must be `projectplanner`,
the `name` in `wrangler.jsonc`, and the build's API token needs permission to
edit D1 as well as Workers, because the deploy command applies migrations.

### From your own computer

```
npm ci
npx wrangler login
npm run deploy
```

The planner is then at `https://projectplanner.<your-subdomain>.workers.dev`
(or on a custom domain if you add one). Plain `http://` addresses are sent on
to `https://`.

## 3. Login phrases and the ElevenLabs key

The phrases are Worker secrets. Set them after the first deploy (until both
are set, nobody can sign in):

```
npx wrangler secret put LOGIN_PHRASE_1
npx wrangler secret put LOGIN_PHRASE_2
npx wrangler secret put ELEVENLABS_API_KEY
```

Each command asks for the value, so it never ends up in your shell history.
You can also set them in the dashboard: the Worker → Settings → Variables and
Secrets → Add, with the type **Secret** **(unverified: menu names)**. Secrets
stay in place when you deploy again. Never commit a phrase or the key, never
paste them into a chat, and do not put them in `wrangler.jsonc`.
`ELEVENLABS_API_KEY` is only used for transcription (phase 2); you may set it
later.

### Which phrase is which person

| Secret | Signs in as | User id | Name at first |
|---|---|---|---|
| `LOGIN_PHRASE_1` | the first person | `00000000000000000000000001` | Person 1 |
| `LOGIN_PHRASE_2` | the second person | `00000000000000000000000002` | Person 2 |

The two users are created by the first migration. The mapping is fixed in
`src/worker/auth/users.ts`; typing a phrase is what tells the planner who you
are, so each person keeps their own phrase to themselves.

### Choosing the phrases

- Phrases are compared after normalising: surrounding spaces removed, runs of
  spaces counted as one, upper and lower case treated alike. "Blue  Kettle"
  and "blue kettle" are the same phrase.
- **The two phrases must differ after normalising.** If they are the same,
  every sign-in is refused (the Worker logs why), because the phrase could
  not tell the two people apart.
- Choose long phrases: several unrelated words that are easy for you to type
  and hard for anyone else to guess. After 5 wrong attempts from one address
  the phrase page stops accepting attempts for 15 minutes, and each further
  lockout lasts twice as long.
- To change a phrase, run `npx wrangler secret put` again. Browsers that are
  already signed in stay signed in; use Settings → Signed-in browsers to sign
  them out.

## 4. Signing in

Open the planner's address. Every page shows "Enter your phrase" until you
sign in. Type your phrase and press **Sign in**. The browser then stays
signed in (a cookie for 400 days, renewed whenever you use the planner), so
each person enters their phrase once per browser.

## 5. Renaming the people

Either person can do this for both. Open **Settings → People**, change the
**Display name** and **Initials** (1 to 3 letters or digits) and press
**Save**. Badges, history and the Activity view then use the new names.

## 6. iPhone home-screen app

On an iPhone, the planner added to the home screen may keep its own cookies,
separate from Safari. You may then need to enter your phrase once more in the
home-screen app, even though Safari is already signed in **(unverified on a
device; SPEC section 10)**.

## 7. Connect Claude

*To be completed in phase 3* (the custom connector in claude.ai, for each
person's own Claude account).

## 8. Claude Project instructions

*To be completed in phase 3* (the instructions each person pastes into a
Claude Project).
