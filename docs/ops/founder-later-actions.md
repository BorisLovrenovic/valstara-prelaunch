# Founder later actions

Status: running list. These are things the founder must do **later**, after the work that needs them has shipped. Each one is easy to forget because nothing breaks while it is undone. A feature simply stays off.

Check this list before launch, after launch, and whenever a ticket ships something that is switched off by default. Add new items at the bottom. When an item is done, move it to **Done** with the date.

---

## Open

### 1. Turn on the automatic Brevo partner sync

- **Added:** 2026-11-22, from E11.7-06 (founder decision recorded on that ticket in `docs/plan/development-plan.md`)
- **When:** after the site is live, once the first partner has signed their contract. Until then there is nobody to sync.
- **Why it matters:** contracted partners are added to Brevo automatically so you can send them programme updates. The sync ships **switched off**. Until you do the steps below, no partner is in Brevo and programme updates can't reach them.

**Steps**

1. In Brevo, go to **Contacts → Lists** and create a new list, for example "Valstara partners".
2. Note the list's numeric **ID**, shown next to the list name.
3. Put that ID into the production configuration under the partner-list setting. E11.7-06 names this setting, and `docs/modules/email.md` documents it once that ticket is merged.
4. Switch on the partner-sync flag with the founder flags command. Its name is in `docs/features/README.md#flag-registry`.
5. Run `partners sync-brevo` once and check that the contracted partners appear in the new Brevo list.

---

## Done

*(Nothing yet.)*
