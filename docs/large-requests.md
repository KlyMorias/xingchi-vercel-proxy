# 50 MiB büyük istek geçidi

## Durum ve sınır

`server.cjs`, mevcut `api/proxy.js` işleyicisini ayrı Node.js 24 HTTP sunucusunda çalıştırır. Varsayılan sınır **50 MiB = 52.428.800 bayt** olup en az 50 MB hedefini karşılar. Bu değer dosya başına değil, bütün HTTP gövdesi içindir; JSON yapısı, base64 kodlaması, metin ve tüm görseller toplama dahildir. Sıkıştırılmış aktarım ile açılmış JSON ayrı ayrı aynı sınırdan geçer. Sağlayıcının model bağlamı, görsel veya içerik sınırlarını değiştirmez.

Harici geçit `https://klyapi-large-requests.onrender.com` adresinde Render Free planıyla kurulmuştur. 25 Kasım 2026 doğrudan canlı doğrulamasında **16/16 kontrol** geçti: tam 50 MiB Content-Length aktarımı `14375 ms`, chunked aktarım `13396 ms` sürdü; küçük gerçek Sol JSON/SSE üretimi ve paylaşılan token kotası da doğrulandı. Bu süreler büyük gövdenin girişten geçiş ölçümüdür; modelin 50 MiB bağlamdan üretim yapabildiğinin garantisi değildir.

Koşullu yönlendirme 25 Kasım 2026'da mevcut `https://klyapi.vercel.app` üretim adresine yayımlanmıştır. **Üretim adresinde tam 50 MiB Content-Length taşımasının 4/4 kontrolü geçti.** Geçerli UTF-8 JSON, iki baytlık JavaScript dizesini tetikleyen bir CJK karakteriyle uygulamaya ulaştı; `X-KlyAPI-Ingress: large` ile beklenen `400 / Requested model is not available` yanıtı döndü, `413` oluşmadı ve token kotası tüketilmedi. Geçici test kayıtları temizlendi. Korumalı Preview'da aynı Content-Length taşıması da geçmiştir.

Üretim testinin istemciden ölçülen toplam süresi `71245 ms` idi. Bunun içinde istemcinin gövdeyi kuyruğa alma göstergesi `65474 ms`, istek yazımının tamamlanması `65557 ms` olarak ölçüldü; bu toplam **sunucu işlem süresi veya garanti edilen API gecikmesi değildir**. Doğrudan Render ve Preview ölçümleri farklı ağ yolları kullandığından tek bir hız garantisine dönüştürülmez. **Doğrudan Render'daki chunked başarısı, aynı aktarımın Vercel zincirinden geçtiği anlamına gelmez.**

Üretim base URL'si üzerinden gerçek Codex CLI doğrulaması da **4/4 kontrolle** geçti. Tamamlanan model yanıtının başarı işareti istemcide `8399 ms` içinde görüldü; sağlayıcının bildirdiği `17123` giriş ve `8` çıkış tokenı tam olarak hesaba işlendi, açık rezervasyon `0` kaldı. Gerçek araç çağrısı veya API hata olayı oluşmadı. Bu tek çağrı ölçümü diğer isteklerin, modellerin veya boşta beklemiş Render hizmetinin aynı sürede yanıt vereceğinin garantisi değildir.

## Vercel'de neden sayı değiştirmek yetmez?

Vercel varsayılan işlev girişinde büyük isteği uygulama çalışmadan keser. Mevcut Vercel işlevi 4.400.000 bayt aktarım sınırını korur; sıkıştırma açıldıktan sonra uygulama sınırı 64 MiB'dir. Yeni 20 MiB Public Beta seçeneği Fluid Compute, Performance 4 GB ve Pro/Enterprise gerektirir ve yine 50 MB'ın altındadır. [Vercel işlev sınırları](https://vercel.com/docs/functions/limitations#request-body-size)

Büyük gövdeler, Vercel **işlevine değil**, harici geçide yönlendirilmelidir. Dış hedefli rewrite URL'yi değiştirmeden HTTP isteğini iletir. Vercel dış hedeften yanıt beklerken 120 saniye sınırı uygular; soğuk başlangıç ve yavaş yüklemeler bu bütçeyi etkiler. Gerçek akış testleri, uzun üretimde de bağlantının açık kaldığını doğrulamalıdır. [Vercel rewrite](https://vercel.com/docs/routing/rewrites), [proxy zaman aşımı](https://vercel.com/docs/limits#proxied-request-timeout)

## Ücretsiz Render kurulumu

Depodaki `render.yaml`, yalnızca `plan: free` olan bir Node web hizmeti tanımlar. Ücretli plan, disk veya veritabanı oluşturmaz. Render hesabı ve bu Git deposuna erişim gerekir; oturum açılması gereken adım hesap sahibinde tamamlanır.

1. Bu dosyalar Git deposunda mevcutken Render Dashboard'da **New → Blueprint** seç, depoyu ve `render.yaml` dosyasını bağla. Alternatif olarak **Web Service → Node → Free** seç.
2. Build: `npm ci --omit=dev --ignore-scripts`; Start: `npm start`; Health Check: `/healthz`. Node ana sürümü 24'tür. Blueprint otomatik deployment'ı kapalı tutar.
3. Mevcut Vercel projesinden **aynı özel Blob deposunun** `BLOB_READ_WRITE_TOKEN` değerini ve `XINGCHI_SOL_API_KEY` değerini Render'ın gizli ortam alanlarına aktar. `BLOB_STORE_ID`/Vercel OIDC harici sunucu için tek başına yeterli değildir. Kullanılacaksa Astra anahtarını da `XINGCHI_ASTRA_API_KEY` olarak ekle; kullanılmayacaksa boş bırak. `UPSTREAM_AUTH_MODE` mevcut ayarla aynı olmalıdır.
4. Yeni, boş hesap deposu açma. Geçit mevcut kullanıcı/anahtar/kota kaydını paylaşır. Yönetici parolası, parola hash'i veya tarayıcı oturum çerezi taşıması gerekmez. Sırları Git'e, komut çıktısına veya istemci dosyalarına yazma.
5. `GATEWAY_MAX_CONCURRENT_REQUESTS=1` ve `GATEWAY_UPLOAD_TIMEOUT_MS=120000` değerlerini koru. Render kendi `PORT` değerini sağlar. `npm start`, `--expose-gc --max-old-space-size=320` bayraklarını zorunlu olarak kullanır; doğrudan bayraksız `node server.cjs` dinlemeyi başlatmaz.
6. Deployment sonrası gerçek `https://...onrender.com/healthz` adresi `{"ok":true}` döndürmelidir. Bu yalnızca sürecin ayakta olduğunu gösterir; doğru Blob/sağlayıcı ayarı için kişisel anahtarla `/v1/models` ve küçük bir model çağrısını da doğrula.
7. Önce doğrudan Render adresinde, sonra Vercel Preview üzerinden aşağıdaki 50 MiB taşıma testini çalıştır. Ancak ikisi geçince üretim yönlendirmesi değiştirilebilir.

Render Free, 15 dakika trafik gelmezse uyur; tekrar açılış yaklaşık bir dakika, bazen 50 saniye veya daha fazla gecikme ekleyebilir. Bu nedenle normal boyutlu istekler Vercel'de tutulur; büyük veya uzunluğu bilinmeyen isteklerde ücretsiz sunucunun soğuk başlangıcı tamamen kaldırılamaz. Workspace başına ayda 750 ücretsiz instance saati vardır. Bant genişliği ve build dakikaları da aylık kotaya tabidir. Ödeme yöntemi yokken aşım hizmeti/build'leri durdurabilir; mevcut ödeme yönteminin ek kullanım ücretleriyle ilişkisini Dashboard'da kontrol et. Render bu planı hobi ve deneme kullanımı için sunar. [Render Free sınırları](https://render.com/docs/free)

512 MB bellekte aynı anda bir büyük istek işlenir; ikincisi `503` ve `Retry-After: 2` alır. Büyük gövdelerden sonra ve upstream için yeniden serileştirmeden önce kontrollü bellek toplama yapılır. Yerel Windows/Node ölçümünde 50 MiB metin gövdesi, iki baytlık JavaScript dizesini tetikleyen tek CJK karakteri ve sağlayıcı aktarım kopyasıyla yaklaşık 359 MiB en yüksek RSS görüldü. Bu ölçüm Render/Linux garantisi değildir; gerçek hizmette bellek, yeniden başlama ve 413/503 oranları ayrıca izlenmelidir. Ücretsiz plan için eşzamanlılık artırılmamalıdır.

## 50 MiB canlı taşıma testi

Önce `KLY_GATEWAY_TEST_BASE` ortam değişkenini gerçek **harici** hizmetin origin'ine, `KLY_GATEWAY_TEST_KEY` değerini mevcut geçerli bir kişisel API anahtarına güvenli şekilde ayarla. Bunları komut satırında veya raporda yazdırma. Aşağıdaki Node kodu tam 50 MiB geçerli JSON gönderir. Bilerek geçersiz model adı kullanıldığı için body okunduktan sonra `400 / Requested model is not available` beklenir; sağlayıcıya üretim gönderilmez ve token kotası ayrılmaz. Geçerli anahtar yine hesap deposunda okunarak doğrulanır.

```js
const assert = require("node:assert/strict");
(async () => {
  const base = new URL(process.env.KLY_GATEWAY_TEST_BASE);
  if (base.protocol !== "https:") throw new Error("An HTTPS gateway URL is required");
  const size = 50 * 1024 * 1024;
  const head = Buffer.from('{"model":"__klyapi_ingress_test__","input":"');
  const tail = Buffer.from('"}');
  const body = Buffer.concat([head, Buffer.alloc(size - head.length - tail.length, 120), tail]);
  assert.equal(body.length, size);
  const response = await fetch(new URL("/api/v1/responses", base), {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.KLY_GATEWAY_TEST_KEY}`, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(180000),
  });
  const result = await response.json();
  assert.equal(response.status, 400);
  assert.equal(result.error, "Requested model is not available");
  console.log("50 MiB transport accepted; no generation requested.");
})().catch(() => { console.error("50 MiB transport test failed"); process.exitCode = 1; });
```

Bu testin başarılı olması modelin 50 MiB içerikten üretim yapabildiğini göstermez. Üretim ve görsel tanıma ayrıca küçük geçerli isteklerle, Responses SSE / Chat Completions / Messages biçimlerinde denenir. 50 MiB + 1 bayt, geçide ulaştığında JSON `413` vermelidir. Giriş hatası, kota hatası veya platform HTML sayfası taşıma testinin başarısı değildir.

### Uzunluğu bilinmeyen aktarımların sınırı

Doğrudan Render'da Content-Length ve HTTP/1.1 chunked 50 MiB girişleri doğrulandı. Buna karşılık korumalı Vercel Preview üzerinden HTTP/1.1 chunked denemesi `502` döndürdü; bu denemede Node geçidinin başlangıç kaydı görülmedi. Node keep-alive ayarının düzeltilmesi bu sonucu gidermedi. Üretim Vercel adresinde HTTP/2 ile Content-Length belirtilmeden gönderilen tam 50 MiB gövde de `502` aldı: istemcinin yazımı `7167 ms`, toplam süre `7420 ms` idi ve o aralıkta Node geçidinde başlangıç kaydı bulunmadı. Bu bulgular hatanın uygulama girişinden önceki vekil zincirinde oluşmasıyla tutarlıdır; hangi platform bileşeninin kestiğini tek başına kanıtlamaz.

Bu nedenle **Vercel üzerinden uzunluğu bilinmeyen büyük yüklemelerin başarısı garanti edilmez**; sınırlama yalnızca HTTP/1.1 chunked aktarımına özgü değildir. Üretimde doğrulanmış 50 MiB yol, doğru Content-Length taşıyan gövdedir. Küçük uzunluğu bilinmeyen isteklerin yönlendirilmesi, büyük bir gövdeyle aynı sonucun alınacağı anlamına gelmez.

Yönlendirme kuralı uzunluğu bilinmeyen POST'u dış hedefe seçer; bu yalnızca hedef seçimini tanımlar, aradaki platformların her aktarım biçimini ilettiğinin garantisi değildir. Hazırlanmış JSON gövdesinin gerçek bayt uzunluğu biliniyorsa istemci bunu doğru `Content-Length` ile göndermelidir. Başlıkta büyük görselin ham dosya boyutu değil, bütün serileştirilmiş HTTP gövdesinin bayt sayısı kullanılır.

## Mevcut Vercel adresini korumak

OpenAI Base URL `https://klyapi.vercel.app/api/v1`, Anthropic Base URL `https://klyapi.vercel.app/api` olarak kalır. İstemcide adres veya mevcut kişisel API anahtarı değişikliği gerekmez. `vercel.json`, mevcut `rewrites` listesini koruyarak iki POST koşulu ekler; hedef `https://klyapi-large-requests.onrender.com` üzerinde aynı yoldur:

| İstek | Yönlendirme hedefi |
| --- | --- |
| POST, `Content-Length > 4400000` | Render büyük istek geçidi |
| POST, `Content-Length` yok; örneğin chunked | Render; Vercel zincirindeki aktarım uyumluluğu ayrıca sınırlıdır |
| POST, bilinen `Content-Length ≤ 4400000` | Mevcut Vercel işlevi |
| Model listesi ve OPTIONS | Mevcut Vercel işlevi |

Harici kurallar yalnızca `/api`, `/v1`, `/api/v1` önekleri altındaki `responses`, `messages`, `chat/completions` yollarına uygulanır; toplam dokuz üretim alias'ı vardır. Kaynak regex'i `^/(api/v1|api|v1)/(responses|messages|chat/completions)$`, yöntem yalnızca `POST`'tur. Sayısal `has` koşulu `content-length` için `{ "gt": 4400000 }`; ikinci kural bu başlığın eksikliğini denetler. Kural yanıtında **`X-KlyAPI-Ingress: large`** başlığı görülür. Bu işaret bilinen küçük isteklerde, model listesinde veya OPTIONS yanıtında bulunmamalıdır.

Statik panel, login, `/api/account`, `/api/keys`, `/api/users`, `/api/auth` ve durum yolları Vercel'de kalır. Bütün `/api/*` yollarını dışarı aktaran catch-all yoktur. Böylece küçük istekler Render'ın uykusuna veya tek büyük istek yuvasına bağlanmaz. Uzunluğu bilinmeyen küçük POST'lar da güvenli boyut denetimi için Render'a gider; bilinen küçük gövde yolunun hız avantajı bu çağrılar için geçerli değildir.

Vercel'in güncel yapılandırması `routes` ile `rewrites` kullanımını ve sayısal başlık koşullarını destekler; yerel `vercel dev` koşullu eşleşmeyi doğrulamaz. Canlı kontroller gerçek yönlendirmeyi, tam `4400000` / `4400001` bayt sınırını, 50 MiB Content-Length girişini, model listesini, OPTIONS'u, kişisel anahtarı, küçük gerçek üretimi ve SSE'nin ilk olayının tamamlanmadan ulaşmasını kapsar. Chunked ve diğer uzunluğu bilinmeyen aktarımların sonuçları ayrı kaydedilir; bir aktarım biçiminin başarısı diğerine genellenmez. Geri dönüş, eklenen iki harici `routes` kuralını kaldırmaktır; mevcut yerel rewrite listesi zaten korunur. [Vercel koşullu yönlendirme yapılandırması](https://vercel.com/docs/project-configuration/vercel-json)

Uzun bir sohbetin hata veren bütün geçmişini tekrar tekrar göndermek yerine sonraki kullanımlarda daha erken otomatik özetleme tercih edilmelidir. Codex kurulum örneğindeki `model_auto_compact_token_limit = 64000`, ilerleyen konuşmalarda gövdenin yeniden büyümesini azaltır; daha önce başarısız olmuş bir yüklemeyi kendiliğinden küçülttüğünün garantisi değildir.

## Yerel ve Docker çalıştırma

Node.js 24 ile gerekli ortam değişkenlerini süreçte tanımladıktan sonra:

```sh
npm ci --omit=dev --ignore-scripts
npm start
```

Sunucu `0.0.0.0:$PORT` üzerinde, PORT yoksa 3000'de dinler. `GET /healthz` ve yukarıdaki tam API yolları dışında dosya, yönetici veya panel sunmaz. Yanıtlarda kullanıcı/sağlayıcı anahtarları, hesap verileri veya kaynak kodu bulunmaz.

Docker alternatifi:

```sh
docker build -t klyapi-gateway .
docker run --rm -p 3000:3000 --env-file /secure/path/gateway.env klyapi-gateway
```

Docker bağlamı `.dockerignore` ile izin verilen uygulama dosyalarıyla sınırlıdır; `.env`, `.vercel`, Git ve testler imaja alınmaz. Ortam dosyası Git deposunun dışında ve yalnızca yerel kullanıcı tarafından okunabilir tutulmalıdır.

## Ek korumalar ve doğrulama

Geçit, büyük gövde okunmadan kişisel anahtarı depo üzerinden salt okunur biçimde doğrular; üretim rezervasyonu yükleme bittikten sonra yeniden yetki kontrolü yapar. Gövdeler günlük dosyasına veya diske yazılmaz. İstemcinin sağladığı `x-vercel-forwarded-for`, `x-forwarded-for` ve `x-real-ip` kaldırılır; proxy gerçek socket IP'sini kullanır. Başlık ve toplam yükleme süresi 120 saniyeyle sınırlıdır. Keep-alive 120 saniyedir; Render kenar vekilinin bağlantıyı yeniden kullanırken kapanmış bir Node soketine denk gelmesini önlemek için platformun önerilen ayarı uygulanır. İstemci kopunca upstream iptal edilir. Boyut aşımında soketi hata gövdesinden önce yok etmek yerine JSON 413 gönderilip bağlantı kapatılır.

Üretim ortamındaki uygulama tanıları, izin verilen POST yollarında yalnızca yükleme yaşam döngüsünü gözler: süreç içi sayısal `request_id`, sabit aşama (`start`, `end`, `aborted`, `response_finish`, `response_close`), geçen milisaniye, geçerli beyan edilmiş bayt sayısı veya `null`, chunked/100-continue işaretleri ve gönderilmişse HTTP durumu. Bu dinleyiciler gövdeyi okumaz, kopyalamaz veya akışın okunma kipini değiştirmez. İstek içeriği, parola, API anahtarı, IP adresi, hesap kimliği, URL sorgusu veya serbest başlık değerleri bu uygulama kayıtlarına yazılmaz. Bu kayıtlar bir isteğin Node'a ulaşıp ulaşmadığını ayırmaya yardımcı olur; platformun kendi erişim günlükleri ayrı bir katmandır.

Yalnızca harici geçitte JSON derinliği 128, tırnak dışındaki yapısal öğe sayısı 100.000 ile sınırlıdır. Bu sınır büyük base64 metnini küçültmez; milyonlarca küçük nesnenin 50 MiB içinde aşırı heap oluşturmasını önler. Karmaşıklık ihlali `400` verir. Paylaşılan Vercel işlevinin mevcut JSON yapısı davranışı değiştirilmez.

```sh
node --test test/server.test.js test/request-body.test.js test/request-complexity.test.js test/large-request-routing.test.js
npm test
```

Yerel testler gerçek HTTP 50 MiB Content-Length/chunked girişini, fazla baytta okunabilir 413'ü, tam yol listesini, başarısız anahtarları, eşzamanlılık sınırını, SSE'nin kademeli ulaşmasını, istemci kopuşunda iptali ve süre sınırlarını kapsar. Yapılandırma regresyonu dokuz alias'ın doğru harici yola çevrildiğini, küçük istek fallback'lerinin kaldığını ve panel/hesap/model yollarının harici regex'e girmediğini denetler. Doğrudan Render canlı kontrolleri, Preview ve üretim Content-Length taşıması ile gerçek Codex CLI tamamlanmıştır. Vercel üzerinden uzunluğu bilinmeyen 50 MiB denemelerinin `502` sınırlaması başarı kayıtlarıyla birlikte korunur.
