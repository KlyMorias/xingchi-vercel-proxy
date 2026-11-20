# KlyAPI

Vercel üzerinde çalışan kişisel API anahtarı paneli ve Xingchi API geçidi.

- `/key`: tarayıcıya bağlı anonim oturumla anahtar oluşturma, tek seferlik gösterme, kullanım görüntüleme, yenileme ve iptal.
- `/`: aynı anahtar paneli.
- `/api`: JSON hizmet bilgisi.
- `/api/v1`: OpenAI uyumlu istemciler için Base URL. `/api/responses` gibi kısa yollar ve önceki `/v1` yolları da desteklenir.
- Model: `gpt-6.1-sol`.

Kişisel anahtarlar 30 gün geçerlidir. Her anonim oturumda bir aktif anahtar bulunur. Günlük üretim kotası 50, dakikalık çağrı sınırı 5'tir. Anahtar yenilemek oturumun kullanım sayaçlarını sıfırlamaz. Hatalı upstream yanıtları günlük kotadan iade edilir; hız sınırı korunur. Model listesi günlük üretim kotasını tüketmez. Sayaçlar UTC gün sınırında yenilenir.

## Kalıcı veri ve kurulum

Kişisel anahtarlar ve sayaçlar Upstash Redis'te tutulur. API anahtarlarının tamamı ve IP adresleri veritabanına yazılmaz; yalnızca hash'ler, kısa anahtar ön eki, oluşturma/son kullanım tarihleri ve sayaçlar saklanır. Aynı IP'den günlük en fazla üç anahtar oluşturulabilir. Bu, hesap doğrulaması içermeyen anonim bir başlangıç sistemidir; tarayıcı verileri silinirse yönetim oturumu kaybolur.

Tüm doğrulama, iptal ve kota kararları Redis'te tek atomik Lua işlemiyle yapılır. Veritabanına ulaşılamadığında kişisel anahtar erişimi kapalı kalır. Ücretsiz plan ve tek birincil bölge kullanılır; otomatik ücretli plan yükseltmesi kapalı olmalıdır.

Vercel ortam değişkenleri:

| Değişken | Amaç |
| --- | --- |
| `XINGCHI_API_KEY` | Upstream anahtarı, yalnızca sunucuda Secret olarak |
| `KEY_HASH_SECRET` | Oturum ve IP hash'leri için en az 32 karakterlik ayrı sır |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Vercel Upstash bağlantısının Redis REST bilgileri |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Yukarıdaki Redis değişkenlerine alternatif |
| `PROXY_ACCESS_TOKEN` | Önceki sahip erişim anahtarı; kişisel kota dışında sahibin özel erişimi |
| `UPSTREAM_AUTH_MODE` | `authorization` (varsayılan) veya `x-api-key` |
| `MAX_OUTPUT_TOKENS` | Çağrı başına çıktı sınırı, varsayılan 2048, en çok 8192 |

Vercel CLI ile ücretsiz Redis oluşturma:

```sh
vercel integration add upstash/upstash-kv --name klyapi-keys --billing-plan free --meta primaryRegion=fra1 --meta eviction=false --meta prodPack=false --meta autoUpgrade=false --environment production --no-env-pull
```

İlk kurulumda Vercel, Upstash sözleşmesinin hesap sahibi tarafından kabulünü ister. Bu adım tamamlanmadan kişisel anahtar oluşturma çalışmaz. Kaynak kodu ve sır içermeyen panel yayımlanabilir. Ortam değişkenlerinden sonra `vercel deploy --prod --yes` ile yeniden dağıt.

## Mevcut sağlayıcı kısıtlaması

20 Kasım 2026'da model listesi çalıştı; standart Responses API isteği upstream'den `403 client_not_allowed`, Chat Completions isteği `chat_completions_disabled` aldı. Panel bu durumu açıkça gösterir. Geçit sağlayıcı izinlerini değiştirmez ve onaylı bir kodlama istemcisinin kimliğini taklit etmez.

## Kontrol

Node.js 20 veya üzerinde `npm test`. Testler kimlik doğrulama, JSON boyut sınırı, streaming, upstream hataları, Redis arızasında erişimin kapanması, tek seferlik anahtar gösterimi, origin kontrolü, kota rezervasyonu ve hata iadesini kapsar. Gerçek Redis bağlantısıyla eşzamanlı kota ve iptal akışı da dağıtım sonrasında doğrulanmalıdır.
