# Founder later actions

Status: running list. These are things the founder must do **later**, after the work that needs them has shipped. Each one is easy to forget because nothing breaks while it is undone. A feature simply stays off.

Check this list before launch, after launch, and whenever a ticket ships something that is switched off by default. Add new items at the bottom. When an item is done, move it to **Done** with the date.

---

## Open

### 1. Turn on the automatic Brevo partner sync

- **Added:** 2026-11-22, from E11.7-06 (founder decision recorded on that ticket in `docs/plan/development-plan.md`)
- **When:** after the site is live, once the first partner has signed their contract. Until then there is nobody to sync.
- **Why it matters:** contracted partners are added to a dedicated Brevo list for programme updates. The sync ships **switched off** and the partner list stays empty until you set it up.

**Steps**

1. In Brevo, go to **Contacts → Lists** and create a new list, for example "Valstara partners".
2. Note the list's numeric **ID**, shown next to the list name.
3. Add the required contact attributes listed in [the email module](../modules/email.md#automatic-partner-list-sync).
4. Set `BREVO_PARTNER_LIST_ID` in the production configuration to that ID. Use a dedicated list whose ID differs from `BREVO_LIST_ID`. Recreate the app and maintenance containers to load it.
5. Enable `partners.brevo_sync` with the founder flags command.
6. Run `partners sync-brevo` once and check that eligible contracted partners and their attributes appear in the new list. Use the automatic sync for all subsequent updates and retire any saved import files.

---

## Done

*(Nothing yet.)*
