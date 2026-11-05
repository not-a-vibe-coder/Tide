/**
 * General memecoin trading knowledge for the AI. These are patterns, not
 * data: the model uses them to explain why a flag matters, and only states
 * facts about a specific token from the live lookups.
 */
export const PLAYBOOK = `How memecoins usually work (general knowledge; use it to explain why something matters, never as a fact about a specific token unless the lookup shows it):

Liquidity and exits
- The pool's liquidity is the real exit. A token "worth" $5M with $30k of liquidity can't be sold for anywhere near $5M; a few sells crater the price. Valuation divided by liquidity is a better danger gauge than market cap alone.
- Thin pools mean big slippage both ways. A $200 buy in a $10k pool moves the price a lot, and so does your sell.
- FDV counts every token that could ever exist. When FDV is far above market cap, a lot of supply is still locked or unissued and can hit the market later.

How launches go
- On solana, most memecoins start on a bonding curve launchpad (pump.fun is the big one). Price rises as people buy along the curve; when it fills, the token "graduates" to a real dex pool (pumpswap or raydium). Graduation often brings a spike and then heavy selling as curve buyers take profit.
- Sui has launchpads with similar curves, plus pools on dexes like cetus and bluefin.
- The first hours are the most violent. Most launches lose most of their value within days. The ones that survive usually have real liquidity, spread-out holders and buyers who keep coming after the first spike.
- Snipers and bundled launches: bots or the creator's own wallets buy in the first seconds, then sell into the people who arrive later. Signs are a few wallets holding a big share early, and lots of buys from very few wallets.

How rugs happen
- Hard rug: the creator pulls the liquidity. On solana graduated pools the lp is usually burned, which removes that lever; on fresh custom pools it may not be.
- Soft rug: the creator or insiders sell their bags slowly or all at once. Concentrated holders are the warning.
- Honeypot: you can buy but not sell. On solana that's usually freeze authority, a transfer hook, or a punishing transfer fee.
- Dilution: mint authority still on means more supply can appear at any time.
- Community takeover (cto): when a creator abandons a token, holders sometimes take over its socials. It can revive a token, it doesn't make it safe.

Reading activity
- Volume many times bigger than liquidity in a day is often wash trading, the same money cycling to look busy.
- Many trades from few wallets looks like bots. Many distinct buyers is a better sign than a big volume number.
- A spike after a long quiet period is more interesting than a token that's already up 300% today. By then the early buyers are often the sellers, and late buyers become their exit liquidity.
- More sellers than buyers after a pump usually means the move is fading.

Managing risk (say these as a friend, not a lecture)
- Size so a total loss doesn't hurt: with launches, assume it can go to zero.
- Chasing a green candle after missing the move is the most common way people get hurt.
- Taking the initial out after a big move lets someone stay in without risking more.
- Revenge trading after a loss, or doubling down to win it back, is exactly what a weekly budget is for.`;
