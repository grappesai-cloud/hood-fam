# Viteza: cum masuram si ce am castigat

Scopul e simplu: platforma sa fie mai rapida decat Pons si restul, pe ce simte userul. Userul nu
simte gaz-ul de pe contract (ala e fix), simte cat de repede se incarca boardul, pagina unui token,
portofoliul, si cat de instant pare un trade. Toate astea trec prin API-ul de citire si prin baza.
Documentul asta e metoda (masuram, nu ghicim) si castigurile de pana acum.

## Metoda

Nu optimizam pe intuitie. Ridicam o baza cu volum realist (5.000 de tokenuri, ~500.000 de balante,
200.000 de puncte), rulam `explain (analyze)` pe query-urile pe care le loveste fiecare pagina, si
cautam `Seq Scan` acolo unde ar trebui `Index Scan`. Apoi masuram din nou, prin API-ul real, cu
`curl -w %{time_total}`.

```sh
# baza de perf (aruncabila)
docker run -d --name hood-perf-db -e POSTGRES_USER=hood -e POSTGRES_PASSWORD=perf -e POSTGRES_DB=hood -p 55998:5432 postgres:17
# aplica schema reala ruland migrate() din sursa, apoi seed (vezi git history pentru scriptul de seed)
# masoara un query:
psql ... -c "explain (analyze) select ... "
```

## Castiguri masurate

**Portofoliul: 30 ms -> 0.2 ms la nivel de query (de 137 de ori).** Pagina de portofoliu citeste ce
detine o adresa: `select ... from balances where address = $1 and balance > 0`. `balances` e cea mai
mare tabela din schema (un rand per detinator per token) si nu avea index pe `address`, deci era un
Seq Scan complet care creste la nesfarsit cu numarul total de detinatori. Index partial pe `address`
(pe acelasi filtru `balance > 0`) -> Bitmap Index Scan. Prin API, cu join si puncte cu tot, pagina
scade de la o scanare completa la indexat.

**Leaderboard: 90 ms -> 2.6 ms prin API (de 35 de ori pe lovirile repetate).** Boardul live insumeaza
FIECARE punct dintr-un sezon la fiecare cerere, iar aplicatia, care ia cu `no-store`, il cere la
fiecare navigare. Costul e agregarea, nu scanarea, deci un index nu ajuta - un cache scurt in proces
(5 secunde) da. Raspunsul abia se schimba de la o secunda la alta, si un sezon inghetat nici nu
ajunge pe calea asta.

**Stats: 3.5 ms -> 0.8 ms.** `count(distinct trader)` peste toata tabela de trade-uri e scump si
cifrele de titlu se misca lent; 10 secunde de cache fac o lovire repetata o cautare in map.

Cache-ul e per-instanta si best-effort: o a doua replica isi tine propriul cache, iar staleness-ul e
exact TTL-ul, ceea ce e in regula pentru un board. Nu cache-uim niciodata date per-user sau per-trade.

**Bundle frontend: pagina de token 312 kB -> 263 kB First Load** (partea specifica paginii 61 kB ->
11.7 kB). Pagina de token e cea mai vizitata (fiecare click pe un token) si cea mai grea. `Chart`
importa `lightweight-charts` (~45 kB) eager, desi graficul e un widget sub caseta de trade, nu primul
lucru de care are nevoie un trader. Trecut pe `next/dynamic` cu `ssr: false` si o schema de incarcare:
libraria de charting se incarca dupa paint, intr-un chunk separat, deci pagina picteaza si caseta de
trade e interactiva fara sa astepte graficul. La fel, `SupportChat` (butonul de help) statea in
layout-ul root, deci in bundle-ul initial al FIECAREI pagini desi se deschide doar la click; mutat
intr-un wrapper client cu `ssr: false`, se incarca dupa hidratare. Verificat in browser: board
stilizat, butonul help apare, chunk-ul de chart NU e pe board; in containerul de productie CSS si JS
servesc 200.

## Ce urmeaza (candidati masurabili, nefacuti inca)

- **Search pe board** (`lower(name) like '%q%'`): la 5.000 de tokenuri e 2 ms (Seq Scan pe o tabela
  mica), nu merita inca. La zeci de mii, un index GIN pg_trgm il face instant.
- **Candles**: agregarea OHLC per token scaneaza toate trade-urile tokenului. Pentru tokenuri foarte
  active, un rollup materializat (bucket de 1 min) pre-calculat de indexer ar taia asta.
- **Bundle-ul frontend**: wagmi/viem sunt grele la primul load. Un audit de bundle + code-splitting pe
  paginile grele (launch wizard, admin) ar scadea Time-to-Interactive.
- **Cache-Control pe API** pentru un CDN/Traefik in fata: ar servi repetari fara sa atinga procesul,
  dar cu grija la freshness-ul trade-urilor.

Regula: fiecare dintre astea se masoara inainte si dupa, cu numere in commit, nu "pare mai rapid".
