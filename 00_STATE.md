# KAVUP — Τρέχουσα κατάσταση (7 Σεπτ 2026)

## Τι είναι
Εφαρμογή διαχείρισης κάβας για bars/clubs, ελληνικά, PWA. Ιδέα για SaaS
(setup fee + μηνιαία συνδρομή). Multi-tenant backend (κάθε μαγαζί ξεχωριστό).

## Πού είναι hosted
- **GitHub repo (private):** pgeorginis-coder/KAVUP — συνδεδεμένο με Vercel
- **Netlify (live, δουλεύει):** https://extraordinary-custard-c851af.netlify.app
- **Vercel (live, δουλεύει):** νέο link μέσω GitHub, ελέγξτε στο vercel.com dashboard
- **Supabase project:** tfiriedreqmjghaxqwtf.supabase.co (backend + βάση)

## Αρχεία σε αυτό το πακέτο
- `index.html` = `kavup-secure.html` — το ΠΛΗΡΕΣ frontend, ένα αρχείο, ό,τι ανεβαίνει στο Netlify/Vercel
- `02_edge_function_index.ts` — ολόκληρο το backend, ανεβαίνει στο Supabase → Edge Functions → "api"
- `01_schema.sql`, `03_add_ordering.sql`, `04_add_backups.sql`, `05_add_crate_size.sql`, `06_add_staff_name.sql` — SQL migrations με τη σειρά (όλα ήδη τρεγμένα στο production, κρατιούνται για ιστορικό/αναφορά)

## Χαρακτηριστικά που υπάρχουν ήδη
- Απόθεμα (grid/list/compact view), drag & drop reorder, pull-to-refresh
- Παραγγελία: πρόταση σε μπουκάλια ή κιβώτια (crate_size ανά προϊόν, μόνο για Χυμοί/Αναψυκτικά/Άλλα)
- Ιστορικό: αναζήτηση (όνομα ή ημερομηνία), φίλτρο ρόλου, όνομα μπάρμαν σε κάθε κίνηση
- Ρυθμίσεις: dark/light (μόνο Standard χρώμα, τα άλλα 3 αφαιρέθηκαν), PIN/Face ID, backups, "Το όνομά σου"
- Admin + Viewer ρόλοι με ξεχωριστούς κωδικούς
- Πλήρες security audit έγινε (7 Σεπτ) — δες παρακάτω

## Security audit (7 Σεπτ) — τι διορθώθηκε
- Race condition σε bulk add/remove ποσότητας → έγινε atomic (delta-based RPC)
- Guard κατά διπλού-click σε +/- κουμπιά
- delete_shop απαιτεί πλέον re-verification κωδικού
- Ελάχιστο μήκος κωδικού 4→6 χαρακτήρες
- Server-side whitelist κατηγοριών προϊόντων
- Όρια μεγέθους σε τιμή/ποσότητα/κιβώτιο/φωτογραφία
- Εμπλουτισμένο audit log (πριν/μετά τιμή σε αλλαγές ορίου/τιμής)
- Tenant isolation, RLS, XSS, secrets exposure: ελέγχθηκαν, βρέθηκαν ήδη σωστά

## Γνωστό, αποδεκτό ρίσκο (δεν έχει διορθωθεί)
Το Quick PIN/Face ID αποθηκεύει τον πραγματικό admin κωδικό σε plaintext στο
localStorage της συσκευής, για να μπορεί να ξανασυνδέεται αυτόματα. Αν το
αλλάξουμε, σπάει το workflow. Αποδεκτό ρίσκο για προσωπική/έμπιστη συσκευή.

## Εκκρεμότητες / επόμενα βήματα
- **Subscription lock (SaaS)**: συζητήθηκε αλλά ΔΕΝ έχει υλοποιηθεί ακόμα.
  Σχέδιο: πεδία `subscription_status` + `paid_until` στο `shops`, το
  `get_shop_data`/login να επιστρέφει "locked" state αν έχει λήξει,
  χειροκίνητο toggle από εσένα (χωρίς integration πληρωμών προς το παρόν).
- **Email password reset**: συζητήθηκε, χρειάζεται εξωτερικό email service
  (π.χ. Resend) — δεν έχει αποφασιστεί/υλοποιηθεί.
- **Netlify billing**: πλήρωσε $9 (Personal plan) για να ξεμπλοκάρει credits.
  Θυμήσου να κάνεις batch deploys (~1/μήνα) πριν λήξει το paid μήνα, αλλιώς
  θα ξαναχτυπήσει το όριο των 300 credits όταν γυρίσει σε Free.
- **Vercel**: Hobby plan απαγορεύει εμπορική χρήση — μόλις αρχίσεις να
  χρεώνεις πελάτες θα χρειαστείς Vercel Pro (~$20/μήνα) αν μείνεις εκεί.
