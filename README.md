# KlyAPI

Vercel'de çalışan, yalnızca yöneticinin eklediği hesaplara açık API paneli.

## Kullanım

- `/login`: kullanıcı adı ve parola ile giriş. Herkese açık kayıt yoktur.
- `/key`: kişisel API anahtarı oluşturma, kopyalama, yenileme ve iptal.
- Panelde **Kullanıcılar**: yönetici kullanıcı ekler, hesabı kapatır, parola sıfırlar ve kota ayarlar.
- Panelde **Şifre değiştir**: mevcut kullanıcı kendi parolasını değiştirir.
- OpenAI Base URL: `https://klyapi.vercel.app/api/v1`
- Anthropic Base URL: `https://klyapi.vercel.app/api`
- Model: `gpt-6.1-sol`

Bir hesapta bir aktif API anahtarı bulunur; anahtar 30 gün geçerlidir ve tam değeri yalnızca oluşturma yanıtında gösterilir. Varsayılan kota günlük 50 üretim isteği ve dakikada 5 çağrıdır. Yönetici bunları kullanıcı bazında değiştirebilir. Yenileme günlük kullanımı sıfırlamaz. Model listesi günlük üretim kotasını tüketmez; başarısız upstream çağrılarında günlük kota iade edilir. Günlük sayaç UTC 00:00'da yenilenir. Kapatılmış kullanıcıların oturumları ve API anahtarları erişemez. Eski ortak sahip tokenı artık kabul edilmez.

## Kalıcı depolama ve güvenlik

Hesaplar, parola hash'leri, oturum hash'leri, API anahtarı hash'leri ve kotalar özel Vercel Blob deposunda saklanır. Tam parolalar veya tam API anahtarları kalıcı depoya yazılmaz. Okumalar `useCache:false` ile en son sürümü getirir; güncellemeler ETag `ifMatch` ile karşılaştırılıp yazılır. Eşzamanlı değişiklik çakışmaları yeniden denenir; depolama arızasında erişim kapalı kalır.

Bu depo, küçük ve davetli kullanıcı grupları için tek JSON kaydı kullanır. Kullanıcı üst sınırı, giriş denemesi sınırı, oturum ömrü ve kayıt boyutu kodda sınırlandırılmıştır. Daha yüksek trafik için aynı arayüz ilişkisel veritabanına taşınabilir.

Parolalar Node.js scrypt ile ayrı rastgele salt kullanılarak hash'lenir. Oturum çerezi Secure, HttpOnly ve SameSite=Strict'tir. Parola değişiminde eski oturumlar geçersiz olur. Yönetici işlemleri her istekte sunucuda yetki kontrolünden geçer; arayüzde düğme gizlemek tek başına yetkilendirme değildir. Kullanıcı bilgilerini değiştiren isteklere origin ve JSON boyut kontrolü uygulanır.

## Vercel kurulumu

Özel Blob deposunu projeye OIDC ile bağla:

```sh
vercel storage create klyapi-private --type blob --access private --region iad1
vercel storage connect klyapi-private --yes
```

| Ortam değişkeni | Amaç |
| --- | --- |
| `BLOB_STORE_ID` | Bağlı özel Vercel Blob deposu; OIDC kimliğiyle erişim |
| `XINGCHI_API_KEY` | Yalnızca sunucuda kullanılan upstream API anahtarı |
| `KEY_HASH_SECRET` | Giriş denemesi anahtarlarını hash'lemek için ayrı rastgele sır |
| `ADMIN_USERNAME` | İlk yönetici kullanıcı adı, yalnızca ilk veri oluşturulurken |
| `ADMIN_PASSWORD_HASH` | İlk yöneticinin scrypt parola hash'i; düz parola değildir |
| `MAX_OUTPUT_TOKENS` | İstek başına çıktı tavanı, varsayılan 2048, en çok 8192 |
| `UPSTREAM_AUTH_MODE` | `authorization` (varsayılan) veya `x-api-key` |

Başlangıç yönetici bilgileri kaynak kodunda bulunmaz. İlk veri oluşturulduktan sonra panelden yapılan parola değişiklikleri ortam değişkeniyle geri alınmaz. Sırlar `.gitignore` ve `.vercelignore` ile kaynak dağıtımından dışlanır.

## İstemci uyumluluğu

Upstream'e Responses API biçiminde akışlı istek gönderilir; Chat Completions ve Anthropic Messages istek/yanıtları dönüştürülür. JSON isteyen istemcilerde tamamlanan yanıt birleştirilir; streaming isteyenler için olaylar ilgili protokole çevrilir. Kodlama istemcisi uyumlu başlıklarda KlyAPI geçidi belirtilir. Metin, görsel girdiler ve işlev araçları desteklenir. Ses, belge blokları veya dönüştürülemeyen seçenekler 400 hatası verir. Kesilen upstream akışları başarılıymış gibi gösterilmez.

## Doğrulama

Uzun yanıtlar sırasında geçit 8 saniyede bir JSON öncesinde boşluk veya SSE yorum satırı göndererek kısa okuma zaman aşımına sahip istemcilerde bağlantıyı canlı tutar. Bunlar model çıktısı değildir. İlk bağlantı/giriş doğrulaması veya istemcinin toplam süre sınırı hâlâ zaman aşımına uğrayabilir; istemci tarafında 120 saniye veya üzeri süre önerilir. Bekleme verisi gönderildikten sonra HTTP durumu değiştirilemeyeceğinden geç oluşan hatalar yanıt gövdesindeki `error` alanında bildirilir. İstemciler HTTP 200 yanında `error` alanını da kontrol etmelidir. Bekleme başlamadan oluşan hatalar kendi HTTP durumlarını korur.

Geçici depolama okuma hataları ve kesin reddedilmiş yazma hız sınırları sınırlı olarak yeniden denenir. Sonucu belirsiz yazma hataları yeniden denenmez. Tanı kayıtları yalnızca aşama, HTTP durum kodu ve sabit hata sınıfı içerir; kullanıcı parolaları, API anahtarları ve istek gövdeleri kaydedilmez.

Node.js 20+ ile `npm test`. Testler yetkilendirme, parolalar, kullanıcı yönetimi, kişisel anahtarlar, eşzamanlı sayaçlar, ETag yeniden deneme, protokol dönüşümleri, SSE ve upstream hatalarını kapsar. Canlıya alırken giriş → anahtar oluşturma → gerçek model çağrısı → iptal akışı ayrıca doğrulanmalıdır.
