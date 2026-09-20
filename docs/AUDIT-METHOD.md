# Auditul in casa: cum il facem si cum il repeti

Nu ne permitem o firma externa, deci facem noi ce face o firma, cu unelte care gasesc clasa de bug
pe care ochiul o rateaza. Documentul asta e ce ruleaza cineva ca sa refaca auditul de la zero, plus
ce inseamna fiecare rezultat. Nu tine locul unui audit extern (vezi la final de ce), dar ridica
serios pragul.

Straturile, in ordinea increderii pe care o dau:

1. **Teste unitare + pe fork** - ce am scris deja, exemple concrete cu raspuns cunoscut.
2. **Teste de invariant (fuzzing)** - mii de secvente aleatoare de tranzactii, verificand proprietati
   care nu trebuie sa se strice niciodata. Aici s-au gasit C1/H1/H2.
3. **Executie simbolica** - demonstreaza o proprietate pentru TOATE intrarile, nu doar pentru cele
   incercate.
4. **Analiza statica** - Slither, ruleaza in CI.

## Cum rulezi tot

```sh
# 1. unitare + INVARIANTE pe stare simulata (se prind automat, sunt in test/invariant)
forge test --no-match-path 'test/Fork*.t.sol'
# fork: unitare pe v4/LayerZero reale + INVARIANTA pe fork (test/ForkDirectInvariant.t.sol)
forge test --match-path 'test/Fork*.t.sol' --fork-url robinhood

# 2. invariantele mai adanc decat implicit, cand vrei sa le storci
FOUNDRY_INVARIANT_RUNS=2000 FOUNDRY_INVARIANT_DEPTH=256 forge test --match-path 'test/invariant/*'

# 3. dovezile simbolice (halmos: pip install halmos)
halmos --match-contract CurveMathSymbolic --function check_buyCostsAtLeastWhatItSellsFor

# 4. static
slither . --filter-paths "lib/|node_modules/|test/|script/" --exclude-dependencies \
  --exclude-informational --exclude-optimization --exclude-low

# 5. mutation: introdu bug-uri intentionat si verifica ca testele le prind
python3 scripts/mutation/run.py
```

## Ce acopera invariantele, si ce inseamna daca pica

Toate sunt in `test/invariant/`. Fiecare ruleaza 256 de secvente x 64 de apeluri = ~16.000 de
tranzactii aleatoare, si dupa fiecare verifica proprietatile. Daca una pica, forge iti da secventa
exacta care a spart-o.

**`CurveSolvency.t.sol`** - inima curbei, banii cumparatorilor:
- `reserveCoversEverySeller`: rezerva acopera mereu valoarea in forma inchisa a tot ce s-a vandut.
  Daca pica, un vanzator de la coada ramane fara bani. **Asta e proprietatea de solvabilitate.**
- `balanceIsReservePlusClaimablePlusBonus`: soldul nativ al curbei e la wei rezerva + zecimea
  protocolului + donatii. Zero wei nesocotit.
- `tokenConservation`: niciun token nu apare sau dispare din tranzactionare.
- `soldNeverExceedsCurveSupply`.

**`StakingSolvency.t.sol`** - vaultul de staking:
- `paidOutNeverExceedsPaidIn`: platit-out <= platit-in, la wei. Vaultul nu poate fi drenat.
- `balanceCoversAccounted`: soldul acopera mereu ce datoreaza stakerilor.
- `stakedMatchesBalance`: principalul contabilizat = tokenul detinut; principalul nu se scurge.
- `claimableCoveredWithinDust`: suma revendicabila <= notificat, in limita prafului de rotunjire al
  acumulatorului (un wei per notify se poate pierde la floor, ultimul care revendica il inghite;
  acelasi risc "dust" pe care SECURITY.md il numeste la splitter).

**`SplitterSolvency.t.sol`** - contabilitatea masinii directe (patru drumuri + dividende + zecime):
- `balanceCoversEveryRoad`: soldul acopera simultan toate cele cinci drumuri. Toti pot revendica in
  orice ordine.
- `accountedEqualsRoads`: `accounted` = suma exacta a drumurilor. Cartile se inchid.
- `eligibleSupplyTracksHolders`: baza de dividende urmareste exact detinatorii raportati de token.
- `nothingLeaks`: fiecare wei intrat e ori inca tinut pentru un drum, ori platit. La wei.

**`SeasonDropSolvency.t.sol`** - airdropul, care plateste bani reali. Construieste un arbore merkle
fix de 8 frunze cu dovezi valide (sorted-pair, ca OZ MerkleProof), apoi fuzzeaza ordinea de
claim/claimMany/sweep:
- `claimedNeverExceedsTotal`: un sezon nu plateste niciodata mai mult decat a fost finantat (garda
  PoolExhausted sub orice ordine).
- `paidOutNeverExceedsFunded`: ce a iesit efectiv <= ce a intrat; un dublu-claim sau un sweep care
  se suprapune cu un claim ar sparge asta.
- `everyWeiAccountedFor`: sold + platit + maturat-la-trezorerie = total finantat, la wei.
Plus `test_a_fixture_proof_actually_claims`, care dovedeste ca dovezile verifica on-chain (altfel
invariantele ar fi triviale pe reverturi inghitite).

**`test/ForkDirectInvariant.t.sol`** - acelasi lucru, dar contra Uniswap v4 ADEVARAT pe fork, nu a
unui mock. Aici traia C1. Fuzzeaza buy/sell/buyback/harvest/deepen prin router-ul si hook-ul reale
(runs mici, ca fiecare apel loveste RPC-ul; ~150 de operatii v4 reale per proprietate):
- `lockedLiquidityNeverShrinks`: lichiditatea pozitiei blocate nu scade niciodata sub cat s-a mintat.
  Asta e promisiunea "lichiditatea e blocata", verificata pe pool-ul real.
- `supplyNeverGrows`: supply-ul doar scade (buyback arde), niciodata nu creste.
- `splitterStaysSolvent`: prin callback-urile reale ale hook-ului, splitterul ramane solvent.
- `hookHoldsNoLooseEth`: hook-ul nu sta niciodata pe ETH nesocotit intre swap-uri.
Plus `test_fork_the_harness_actually_trades`, care dovedeste ca handler-ul chiar muta bani, ca sa nu
fie invariantele adevarate degeaba (pe o secventa de reverturi inghitite).

**`test/ForkCurveGradInvariant.t.sol`** - fuzzeaza exact suprafata lui C1 pe v4 real. Cumpara curba,
incearca sa OTRAVEASCA pool-ul pre-deschis inca gol (un swap de un wei il muta la orice pret, fix
atacul), apoi absolveste, si verifica:
- `graduationPutsTheRaiseInThePool`: dupa absolvire raise-ul e in POOL, nu in fee router. Pe C1 se
  scurgea la fee router si, pe CreatorKeep, la creator. Lansarea foloseste dinadins CreatorKeep, ca
  invarianta sa pice zgomotos daca fixul regreseaza vreodata.
- `graduatorHoldsNothing`: graduatorul nu ramane cu token sau pereche.
Plus `test_fork_a_poisoned_empty_pool_cannot_steal_the_raise`, care reproduce C1 determinist si arata
ca e neutralizat (pool otravit la podea, absolvit, raise tot in pool, creator zero).

**`test/ForkBridgeInvariant.t.sol`** - proprietatea anti-backdoor a bridge-ului, contra endpointului
LayerZero REAL de pe 4663. Fuzzeaza trimiteri repetate si verifica:
- `canonicalSupplyIsImmutable`: supply-ul pe 4663 nu se misca niciodata, orice s-ar bridge-ui. Tokenul
  nu are mint; asta dovedeste ca nicio cale de send nu il infleaza. Un backdoor de mint pica aici.
- `lockedEqualsSent`: adaptorul (lock-box) tine la wei exact cat a plecat din float-ul local. Blocat
  == datorat detinatorilor de pe alt lant.
- `lockedNeverExceedsSupply`: nu se poate bloca mai mult decat exista.

## Ce a dovedit executia simbolica

`test/symbolic/CurveMathSymbolic.t.sol`, cu halmos. `check_` ruleaza doar sub halmos; `forge test`
le ignora.

- **`check_buyCostsAtLeastWhatItSellsFor`: DOVEDIT** pentru toate intrarile din interval. O cumparare
  costa mereu cel putin cat vinde aceeasi intindere; spread-ul asta (cumpararea rotunjeste in sus,
  vanzarea in jos) e ce tine rezerva solventa la un dus-intors. Asta e proprietatea critica si e
  demonstrata, nu esantionata.
- `check_priceIsMonotone`, `check_splittingABuyNeverGetsCheaper`, `check_tokensForPairStaysWithinBudget`:
  adevarate algebric si acoperite de invariantele de fuzzing, dar demonstratia simbolica **nu termina
  in timp rezonabil** fiindca `Math.mulDiv` din OpenZeppelin face inmultire pe 512 biti, care e scumpa
  pentru solver. Important: solver-ul nu a gasit contraexemplu, doar nu reuseste sa demonstreze
  absenta lui; daca ar exista unul, z3 l-ar fi gasit repede. Le tinem ca "acoperite de fuzzing,
  demonstratie simbolica blocata de mulDiv", nu ca "dovedite".

## Mutation testing: testam testele

Un strat de teste care trece nu inseamna nimic daca nu prinde bug-uri. `scripts/mutation/run.py`
introduce bug-uri intentionat in codul critic (o rotunjire inversata, o taxa scoasa, o garda
stearsa), ruleaza suita rapida dupa fiecare, si verifica ca suita PICA. Un mutant care supravietuieste
(suita trece cu bug cu tot) nu e un bug in contract - e un gol in teste, si exact asta cautam.

Prima rulare: 6 din 7 omorati, 1 supravietuitor. Supravietuitorul: stergerea plafonului
`snipeDecaySeconds` (fixul M3) nu era prinsa de suita rapida, fiindca singurul test care il verifica
era pe FORK (`ForkDirect`), iar jobul de fork e `continue-on-error` in CI - deci o regresie pe plafonul
ala ar fi trecut prin CI nedetectata. Inchis cu `test_a_launch_cannot_set_a_decay_window_past_the_ceiling`
in `test/DirectHook.t.sol`, in suita rapida care gateuieste. Dupa fix: 7 din 7 omorati.

Asta e valoarea mutation testing-ului: nu gaseste bug-uri in cod, gaseste minciuni in teste. Adauga
un mutant nou punand o intrare `{file, find, replace, why}` in `scripts/mutation/mutants.json`.

## Ce NU acopera nimic din toate astea, si de ce mai trebuie un audit extern candva

- **v4 SI LayerZero sunt acum fuzzlate pe fork** (`ForkDirectInvariant`, `ForkCurveGradInvariant`,
  `ForkBridgeInvariant`), inclusiv atacul C1 si proprietatea anti-backdoor a lock-box-ului (supply-ul
  pe 4663 imutabil, blocat == trimis). Ce ramane: partea de RECEIVE a bridge-ului (unlock) are nevoie
  de lantul destinatie, deci e doar pe teste cu exemple, nu fuzzlata; si combinatiile cross-contract
  pe care nu stim sa le exprimam ca proprietate - exact ce aduce un auditor extern.
- **Bug-uri de logica de business** pe care nicio invarianta nu le exprima fiindca nu stim sa le
  cerem. Un auditor extern aduce proprietati la care noi nu ne-am gandit.
- **Economia** (farmarea punctelor prin volum spalat, L12) - decizie de proiectare, nu proprietate.
- **Cheia keeper fierbinte, ownership pe multisig, operational** - tin de deploy, nu de cod.

Concluzia onesta ramane cea din raportul de audit: pentru testnet si demo, da; pentru mainnet cu bani
care conteaza, munca asta face auditul extern mai ieftin si mai scurt, dar nu il inlocuieste.
