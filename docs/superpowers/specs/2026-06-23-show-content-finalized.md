# Show content — finalized topics + exemplars

Companion content to
[2026-06-23-show-redesign-and-genre-aware-picker-design.md](2026-06-23-show-redesign-and-genre-aware-picker-design.md).
That doc covers the mechanism; this one records the actual per-show content
decided through it — every exemplar below was searched, energy/valence-
checked, and the resulting shortlist verified live against the production
sidecar before being locked in. Not yet applied to the live station — apply
via the Shows admin UI (once
[#15](https://github.com/JonathanLew1s/subwave/pull/15) ships) or the
settings API directly.

"The Workday" (persona Nina Calder) is intentionally excluded — it never
airs in any day's schedule (superseded by the Slow Start/Out to
Lunch/The Long Stretch weekday split) and was left orphaned rather than
deleted or rewritten, per an explicit decision earlier in this work.

## Outstanding manual step (not content, not code)

The Fri/Sat overnight party-night schedule slots are swapped one day off
from the conventional pattern. Fix in the Shows admin weekly grid:
- Day 0 (Sunday) hour 00–05: change from Small Hours → **Electric Picnic**
- Day 5 (Friday) hour 00–05: change from Electric Picnic → **Small Hours**
- Day 6 (Saturday) and days 1–4 (Mon–Thu) are already correct.

## Small Hours
*Overnight, 12am–6am. Moods: `reflective, night, calm`. Persona: Mara Vale.*

> Overnight, 12am–6am — for whoever's still up: insomniacs, night-shift
> workers, a parent awake with the baby, anyone who just doesn't want
> silence. They're not dancing, not working, often not even fully listening
> — nothing should demand attention or break the quiet. Ambient, downtempo,
> folk, trip hop. Wide artist variety.

Exemplars (8): Brian Eno "Zawinul/Lava" (5056), Sigur Rós "They Glow in
Light / Like Coloured Glass" (27543), Floating Points "Promises: Movement
3" (13045), Bon Iver "I Can't Make You Love Me" (4873), James Taylor "One
Man Parade" (15621), Bonobo "7th Sevens" (4943), Nils Frahm "More" (17660),
Portishead "Airbus Reconstruction" (36881).

Derived genre palette: `ambient, folk, downtempo, triphop`.

## First Light
*Dawn–9am weekdays (6–9/10am weekends). Moods: `morning, calm, focus`.
Persona: Elian Brooks.*

> Dawn to 9am — for people waking up and getting moving: making coffee,
> getting dressed, getting kids out the door to school. Energy and
> momentum, not a slow drift — but never loud or jarring. Bright indie rock
> and pop. Wide artist variety.

Exemplars (3): Foals "(summer sky)" (13213), HAIM "Better Off" (14588),
Bombay Bicycle Club "Always Like This" (4792).

Validated shortlist included: Blossoms, Doves, Duran Duran, Mercury Rev, a
mellower Radiohead cut, Red Hot Chili Peppers, Pixies.

## Side B
*Evening. Moods: `celebratory, evening, reflective` (changed from
`romantic, evening, reflective` — see below). Persona: Clara Hart.*

> Evening — indie rock and pop with momentum, not a wind-down. Album
> tracks, character over chart hits. No EDM, no chart pop, no novelty.

Exemplars (3): Foals "2am" (13207), Arctic Monkeys "Arabella" (1177), HAIM
"Forever" (14592).

Pivoted from the original soul/R&B/blues direction to indie per explicit
feedback ("flip it over to Indie, make it a little lively not a wind
down"). `romantic` was also swapped for `celebratory` in the mood list —
verified live this measurably increases energy in the result (Jet, Royal
Blood, Måneskin, Cold War Kids, Sam Fender, Oasis vs. a more
Death-Cab/Pixies-leaning result with `romantic` still in the mix).

## Golden Hour
*End of workday through dinner. Moods: `evening, celebratory, sunny`.
Persona: Theo Mercer.*

> End of workday through dinner — warmth and groove, not high energy.
> Disco, downtempo electronic, house. No EDM, aggressive rock, festival
> anthems.

Exemplars (3): Marvin Gaye "A Funky Space Reincarnation" (20925), Sade
"Cherry Pie" (27287), Daft Punk "Digital Love" (7229).

Thinner result than the others (6 shortlist entries, downtempo-heavy: Four
Tet ×2, Blockhead, Fred again.., Carly Rae Jepsen, Felix Laband) — coherent
but could use one more exemplar for breadth if revisited.

## Electric Picnic
*Party nights + weekend evening. Moods: `celebratory, festival, evening`.
Persona: Leo Winters.*

> (topic unchanged from current — not rewritten this pass)

Exemplars (4, **revised** — see below): Daft Punk "Aerodynamic" (7228),
Justice "Alakazam!" (17777), Bonobo "Age of Phase" (5088, Deep House),
BICEP "Atlas" (2713, Disco).

First draft (Daft Punk, Disclosure ×2, Jamie xx) derived palette
`dance, house, trance` but the resulting shortlist was pop-dominated (Carly
Rae Jepsen ×3, Lady Gaga ×2) — too thin/repetitive, consistent with
`festival`'s already-known weak mood signal (see the main design doc).
Per feedback ("needs more dance/electronic"), revised to the set above —
derived palette `dance, electronic, deephouse, disco`, validated shortlist
genuinely electronic/dance with 8 distinct artists: Justice, Fred again..
(an energetic cut, not a chill one), CamelPhat, Empire of the Sun, a Glass
Animals dance remix, Röyksopp ×2, Aphex Twin.

Once the schedule fix above lands, this show also covers both Fri+Sat
overnight party slots, not just the weekend evening block — worth a topic
review for that wider context (not done this pass).

## Open Hours
*Weekend daytime. Moods: `driving, energetic`. Persona: Isla Reid.*

> Weekend, no agenda — movement and possibility. Indie, alternative dance,
> electronica, bright and expansive. Wide artist variety, not just chart
> singles.

Exemplars (3): Caribou "All I Ever Need" (5774), LCD Soundsystem "Disco
Infiltrator" (19097), MGMT "4th Dimensional Transition" (20648).

Validated shortlist: James Bay, Arcade Fire, Florence + The Machine, Future
Islands, Gabriels, Eurythmics.

## Slow Start
*Weekday morning. Moods: `morning, focus`. Persona: Hale.*

> A weekday morning show for easing into work without the forced
> cheerfulness of typical breakfast radio — warm acoustic and indie-folk,
> soft electric piano, unhurried tempos, gentle vocals. Nothing jarring,
> nothing sleepy. Commentary stays light and infrequent.

Exemplars (2): Fleet Foxes "Blue Ridge Mountains" (12817), Jack Johnson
"3AM Radio" (15486).

This show's real genre guidance previously lived only in `vibe` (dead field
— never reaches the LLM, see the main design doc) and has been folded into
`topic` above.

Validated shortlist: R.E.M., Elbow, Blossoms (acoustic), a mellow
Radiohead cut, Biffy Clyro, Liz Phair, Oasis, Paul Simon.

## Out to Lunch
*Weekday midday. Moods: `energetic, sunny`. Persona: Marlowe.*

> The midday break show — for whoever's stepping away from the desk or
> eating lunch at it. Bright, sunny indie pop, classic soul, funk, breezy
> guitar tracks — upbeat but conversational, never party mode. Tone is dry
> and observational.

Exemplars (3): Curtis Mayfield "Give It Up" (7033), Isley Brothers "Summer
Breeze" (31742), Bombay Bicycle Club "Always Like This" (4792).

Same dead-`vibe` situation as Slow Start, folded into `topic` above.

Validated shortlist: Prince, Måneskin, Catfish and the Bottlemen, Athlete,
Harry Styles, Courteeners.

## The Long Stretch
*Weekday afternoon, 2–5pm. Moods: `focus, driving`. Persona: Wren.*

> The afternoon push, 2-5pm — when energy dips but the to-do list doesn't.
> Downtempo and breakbeat electronic, motorik rhythms, warm synths — steady
> momentum, never demanding attention. The host mostly stays out of the
> way.

Exemplars (2): M83 "Carresses" (20611), Caribou "218 Beverly" (5834).

Same dead-`vibe` situation as Slow Start, folded into `topic` above.

Validated shortlist: Caribou, Bonobo, Four Tet, Blockhead ×2, Leftfield —
leans more chill-downtempo than aggressively "driving" in character, but
every candidate is confirmed within the `focus`/`driving` energy bands by
construction (the mood-band query runs before the genre gate).

## Not started

"The Workday" (orphaned, never airs — see above) was not given a content
pass, by design.
