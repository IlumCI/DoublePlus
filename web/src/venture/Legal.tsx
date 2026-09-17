import { Link } from "react-router-dom";

import { usePageMeta } from "./seo";
import { BRAND } from "../lib/brand";
import { env } from "../lib/env";

/** Terms, risk disclosure and privacy, kept deliberately apart from the rest
 *  of the site: a document, not a surface. Nothing here is styled to sell.
 *
 *  This is standard template wording and has not been through counsel. It
 *  needs a review pass before the mainnet deployment carries real money. */

const UPDATED = "17 September 2026";

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2><span>{n}</span>{title}</h2>
      {children}
    </section>
  );
}

export default function Legal() {
  usePageMeta("Terms and risk disclosure", `Terms of use, risk disclosure and privacy notice for ${BRAND.name}${BRAND.tld}.`);
  return (
    <div className="dp-legal">
      <header>
        <h1>Terms of Use, Risk Disclosure and Privacy Notice</h1>
        <p className="dp-legal-meta">
          {BRAND.name}{BRAND.tld} · last updated {UPDATED} · <Link to="/" viewTransition>return to the site</Link>
        </p>
      </header>

      <Section n="1" title="Acceptance">
        <p>
          By accessing this interface you agree to these terms. If you do not agree, do not use the
          interface. These terms may be revised; continued use after a revision constitutes acceptance
          of the revised terms.
        </p>
      </Section>

      <Section n="2" title="What this interface is">
        <p>
          This site is a front end for a set of immutable smart contracts deployed on {env.chainName}.
          It is non-custodial. It never holds, controls or has access to your assets or your private
          keys, and it cannot move, freeze, reverse or recover any transaction you sign. Every
          transaction is submitted by your own wallet directly to the network.
        </p>
        <p>
          No operator of this interface acts as your broker, dealer, exchange, custodian, fiduciary,
          financial adviser or investment adviser. No content on this site is financial, legal,
          accounting or tax advice, and nothing on it is a recommendation to buy, sell or hold anything.
        </p>
      </Section>

      <Section n="3" title="Eligibility">
        <p>
          You represent that you are of legal age in your jurisdiction, that you are not subject to any
          sanctions programme and are not located in or a resident of any jurisdiction subject to
          comprehensive sanctions, and that your use of this interface does not violate any law that
          applies to you. You are solely responsible for determining whether your use is lawful where
          you are.
        </p>
      </Section>

      <Section n="4" title="No offering of securities">
        <p>
          Tokens created through these contracts are open ERC-20 tokens. They are not registered
          securities, are not issued, underwritten, endorsed or vetted by any operator of this
          interface, and confer no equity, no ownership, no creditor claim, no voting right and no
          legal claim on any company, project or person. Where a token distributes value to holders,
          that value derives from trading fees collected by the contracts, not from the revenue,
          profit or assets of any business.
        </p>
      </Section>

      <Section n="5" title="Risk disclosure">
        <p>
          Using these contracts can result in the total loss of everything you commit. The following
          list is illustrative, not exhaustive.
        </p>
        <ul>
          <li>
            <b>Market risk.</b> Token prices are volatile and can fall to zero. There is no guarantee
            of liquidity, of a buyer at any price, or of any level of trading activity.
          </li>
          <li>
            <b>Smart contract risk.</b> The contracts are unaudited. They may contain errors,
            vulnerabilities or economic flaws. Because they are immutable, defects cannot be patched
            and no operator can intervene on your behalf.
          </li>
          <li>
            <b>Project risk.</b> Anyone can create a token. Descriptions, links, logos and claims
            attached to a project are supplied by its creator and are not verified by any operator of
            this interface. A creator who receives funds is under no obligation enforced by these
            contracts to build anything, and may abandon a project at any time.
          </li>
          <li>
            <b>Counterparty and concentration risk.</b> A small number of holders may control a large
            share of a token's supply and may sell at any time.
          </li>
          <li>
            <b>Protocol and network risk.</b> Chain reorganisations, congestion, outages, bridge
            failures, front-running and maximal extractable value can all affect the outcome of a
            transaction.
          </li>
          <li>
            <b>Regulatory risk.</b> The legal treatment of these assets is unsettled and may change
            in a way that affects their value, transferability or legality in your jurisdiction.
          </li>
          <li>
            <b>Irreversibility.</b> Transactions cannot be undone. Assets sent to a wrong address are
            lost permanently.
          </li>
        </ul>
        <p>Do not commit funds you cannot afford to lose entirely.</p>
      </Section>

      <Section n="6" title="Fees">
        <p>
          The contracts charge protocol fees, which are described in the interface and fixed in the
          contract code at deployment. Network gas fees are separate and are paid by you to the
          network. Fee parameters written into a token at launch cannot be changed afterwards by
          anyone, including its creator and including any operator of this interface.
        </p>
      </Section>

      <Section n="7" title="Prohibited use">
        <p>
          You may not use this interface to launder money, finance terrorism, evade sanctions, defraud
          any person, manipulate any market, infringe any intellectual property right, or in
          connection with any other unlawful activity. You may not attempt to interfere with the
          interface or the contracts, or access them by automated means intended to disrupt them.
        </p>
      </Section>

      <Section n="8" title="Third-party content">
        <p>
          Project names, descriptions, images and external links are supplied by token creators and
          stored on-chain or at addresses those creators control. They are not reviewed, endorsed or
          warranted by any operator of this interface. Links to third-party sites are provided for
          convenience only and carry no endorsement.
        </p>
      </Section>

      <Section n="9" title="No warranty">
        <p>
          The interface is provided "as is" and "as available", without warranty of any kind, express
          or implied, including any warranty of merchantability, fitness for a particular purpose,
          title, or non-infringement. No warranty is given that the interface will be uninterrupted,
          error-free, secure, or that any defect will be corrected.
        </p>
      </Section>

      <Section n="10" title="Limitation of liability">
        <p>
          To the maximum extent permitted by law, no operator, contributor or affiliate of this
          interface is liable for any indirect, incidental, special, consequential, exemplary or
          punitive damages, or for any loss of profits, revenue, data, goodwill or digital assets,
          arising out of or relating to your use of the interface or the contracts, whether based in
          contract, tort, strict liability or any other theory, and whether or not advised of the
          possibility of such damages.
        </p>
      </Section>

      <Section n="11" title="Taxes">
        <p>
          You are solely responsible for determining what taxes apply to your transactions and for
          reporting and remitting them. No operator of this interface provides tax reporting.
        </p>
      </Section>

      <Section n="12" title="Privacy">
        <p>
          This interface does not require an account and does not collect names, email addresses or
          passwords. Preferences such as your last used settings are stored locally in your browser
          and are never transmitted. Connecting a wallet exposes your public address to the
          interface, as it does to any site you connect to.
        </p>
        <p>
          The interface reads public blockchain data through third-party RPC and explorer providers.
          Those providers may log your IP address and request data under their own privacy policies.
          Activity recorded on a public blockchain is permanent, public and outside the control of any
          operator of this interface.
        </p>
      </Section>

      <Section n="13" title="Severability and governing terms">
        <p>
          If any provision of these terms is held unenforceable, the remaining provisions remain in
          full force. Failure to enforce any provision is not a waiver of it.
        </p>
      </Section>

      <footer className="dp-legal-foot">
        <Link to="/" viewTransition>← {BRAND.name}{BRAND.tld}</Link>
        <Link to="/docs" viewTransition>How the protocol works →</Link>
      </footer>
    </div>
  );
}
