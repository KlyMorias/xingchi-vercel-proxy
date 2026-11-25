# 50 MiB büyük istek geçidi

## Durum ve sınır

`server.cjs`, mevcut `api/proxy.js` işleyicisini ayrı Node.js 24 HTTP sunucusunda çalıştırır. Varsayılan sınır **50 MiB = 52.428.800 bayt** olup en az 50 MB hedefini karşılar. Bu değer dosya başına değil, bütün HTTP gövdesi içindir; JSON yapısı, base64 kodlaması, metin ve tüm görseller toplama dahildir. Sıkıştırılmış aktarım ile açılmış JSON ayrı ayrı aynı sınırdan geçer. Sağlayıcının model bağlamı, görsel veya içerik sınırlarını değiştirmez.

Yerel testler tam 50 MiB geçerli görsel JSON'unu hem Content-Length hem chunked HTTP ile mevcut proxy işleyicisinden geçirir. Anahtar/kota ve sağlayıcı bu testlerde kontrollü taklitlerdir; testler gerçek kullanıcı anahtarını veya sağlayıcı bakiyesini kullanmaz. Bu rehber ve Blueprint, harici sunucunun kurulmuş olduğunu veya mevcut üretim adresinin değiştirilmiş olduğunu iddia etmez.

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

Render Free, 15 dakika trafik gelmezse uyur; tekrar açılış yaklaşık bir dakika sürebilir. Workspace başına ayda 750 ücretsiz instance saati vardır. Bant genişliği ve build dakikaları da aylık kotaya tabidir. Ödeme yöntemi yokken aşım hizmeti/build'leri durdurabilir; mevcut ödeme yönteminin ek kullanım ücretleriyle ilişkisini Dashboard'da kontrol et. Render bu planı hobi ve deneme kullanımı için sunar. [Render Free sınırları](https://render.com/docs/free)

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

Bu testin başarılı olması modelin 50 MiB içerikten üretim yapabildiğini göstermez. Üretim ve görsel tanıma ayrıca küçük geçerli isteklerle, Responses SSE / Chat Completions / Messages biçimlerinde denenir. 50 MiB + 1 bayt ve sınırı aşan chunked aktarım, JSON `413` vermelidir. Giriş hatası, kota hatası veya platform HTML sayfası taşıma testinin başarısı değildir.

## Mevcut Vercel adresini korumak

`vercel.json` bu hazırlıkta değiştirilmez. Harici hizmetin gerçek URL'si ve Preview testi hazır olunca yalnızca aşağıdaki API alias'larının **mevcut** destination değerleri değiştirilir:

| İşlem | Kaynak yollar |
| --- | --- |
| Modeller | `/v1/models`, `/api/models`, `/api/v1/models` |
| Responses | `/v1/responses`, `/api/responses`, `/api/v1/responses` |
| Chat Completions | `/v1/chat/completions`, `/api/chat/completions`, `/api/v1/chat/completions` |
| Messages | `/v1/messages`, `/api/messages`, `/api/v1/messages` |

Örneğin `/api/v1/responses`, gerçek Render origin'inde `/api/v1/responses` yoluna harici rewrite yapılır. Statik panel, login, `/api/account`, `/api/keys`, `/api/users`, `/api/auth` ve durum yolları Vercel'de kalır. Bütün `/api/*` yollarını dışarı aktaran catch-all eklenmez. Eski eşleşen rewrite'ı önde bırakıp ikinci kural eklemek de işe yaramaz: ilk eşleşme kullanılabilir.

Preview'da sağlık, 50 MiB taşıma, normal kişisel anahtar, küçük gerçek üretim, SSE'nin ilk olayının tamamlanmadan ulaşması ve uzun yanıt kontrol edilir. Sonra üretim yayımlanır. Geri dönüş, bu alias'ların önceki yerel destination değerlerini geri yüklemektir.

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

Geçit, büyük gövde okunmadan kişisel anahtarı depo üzerinden salt okunur biçimde doğrular; üretim rezervasyonu yükleme bittikten sonra yeniden yetki kontrolü yapar. Gövdeler günlük dosyasına veya diske yazılmaz. İstemcinin sağladığı `x-vercel-forwarded-for`, `x-forwarded-for` ve `x-real-ip` kaldırılır; proxy gerçek socket IP'sini kullanır. Başlık süresi 15 saniye, toplam yükleme süresi 120 saniyedir. İstemci kopunca upstream iptal edilir. Boyut aşımında soketi hata gövdesinden önce yok etmek yerine JSON 413 gönderilip bağlantı kapatılır.

Yalnızca harici geçitte JSON derinliği 128, tırnak dışındaki yapısal öğe sayısı 100.000 ile sınırlıdır. Bu sınır büyük base64 metnini küçültmez; milyonlarca küçük nesnenin 50 MiB içinde aşırı heap oluşturmasını önler. Karmaşıklık ihlali `400` verir. Paylaşılan Vercel işlevinin mevcut JSON yapısı davranışı değiştirilmez.

```sh
node --test test/server.test.js test/request-body.test.js test/request-complexity.test.js
npm test
```

Testler gerçek HTTP 50 MiB Content-Length/chunked girişini, fazla baytta okunabilir 413'ü, tam yol listesini, başarısız anahtarları, eşzamanlılık sınırını, SSE'nin kademeli ulaşmasını, istemci kopuşunda iptali ve süre sınırlarını kapsar. Dış hesap bağlantısı olmadan yalnızca bu yerel kontroller tamamlanabilir; canlı Render/Vercel Preview testi ayrı bir deployment adımıdır.
