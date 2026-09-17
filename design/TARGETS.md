# doubleplus — design targets (written before the fix pass)

Decisions on positioning and mechanism, then the explicit targets for the
judgment calls. The point is to hit these, not merely to stop being criticisable.

## Positioning decisions

1. **Drop the securities claim.** "Security-style stock" reads as a legal
   assertion and sat one scroll from "not registered securities." The product
   concept stays — a tradable stake in a project, with a term sheet, a cap
   table and fee income — but the marketing surface never calls it a security.
   Plain framing: "Back an idea. Own a stake in its market." A short
   "what this is / what it is not" block sits adjacent to the pitch, not
   buried in the footer.

2. **Rename dividends to fee share.** Holders are paid out of trading fees,
   not company revenue. Copy says so in the same breath, every time:
   "holders earn a share of every trade, paid in ETH." The word dividend
   survives only where it names the contract's bucket.

3. **Do not change the contracts this round.** They are deployed and tested.
   Instead, state the binding that exists and the binding that does not:
   all-or-nothing protects backers until graduation; after graduation the
   founder's cut is theirs and only the vested stake is time-locked; there
   is no clawback. Every project page says this in plain words. Milestone-gated
   release of the founder cut is the right contract-level answer and is
   recorded here as the next contract round, not pretended away in the UI.
   No synthetic "trust score" — show the three real terms instead
   (founder cut %, vesting days, per-wallet cap).

## Targets for the judgment calls

- **Tone: confident, not confessional.** Accuracy is non-negotiable;
  self-flagellation is not accuracy. Never apologise for being early, never
  lead with what the product cannot do. Risk language belongs in the docs,
  the terms tab and the footer — stated plainly, once, where someone
  looking for it will find it — not shouted on the hero.
- **Above the fold**: the wedge, in one line, then why this beats a meme
  launchpad in three, then the board. A new arrival should know within five
  seconds what they get here that pump.fun cannot give them: terms they can
  read before they buy, their money back if the raise misses, and fee income
  while they hold.
- **Numbers**: show strength. Where the dataset is thin, show protocol
  guarantees (which are always true) rather than ratios over a sample of one.
  No "this is meaningless yet" notes.
- **Create is a companion, not a form.** Guided steps, plain-language
  explanations of what every setting does to the market, sane defaults that
  work untouched, and real depth folded behind expert settings. Nobody should
  have to search the internet to understand a control.
- **Motion**: only on real events — a row flashes when a trade lands, a card
  enters when a raise is filed. Nothing animates when nothing happened.
  No marquee.
- **Type**: three files, not ten. VG5000 for the wordmark only, Karrik for
  text, Fragment Mono for every number and label. Compagnon and Jgs are gone.
- **Cursor**: the system cursor, everywhere. No exceptions.
- **Hover**: colour and underline. Never a solid block inversion.
- **Contrast**: every text token at 4.5:1 or better on its own background;
  nothing smaller than 11px carries information.
- **Focus**: a visible ring on every interactive element, no exceptions.
- **Docs**: full width, a table of contents, anchor links, and one diagram
  of the mechanism.
