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

## Codex masaüstü ve CLI

Paneldeki [kurulum rehberi](https://klyapi.vercel.app/key#codex-setup), `config.toml` örneğini kopyalar veya indirir. Yeni oluşturulan kişisel `kly_` anahtarı bu sayfa açıkken kopyalama ve indirmeye eklenir; sonraki ziyaretlerde örnekteki yer tutucuyu kendi anahtarınla değiştir. Kaynak sağlayıcının anahtarı bu dosyaya veya tarayıcıya eklenmez.

Ayarları kullanıcı düzeyindeki `%USERPROFILE%\.codex\config.toml` (Windows) veya `~/.codex/config.toml` dosyasıyla birleştir; mevcut seçenekleri ve eklentileri koru, aynı TOML bölümünü iki kez tanımlama. Uygulamayı yeniden açıp yeni sohbet başlat. Örnek `KlyAPI` sağlayıcısını ve Responses protokolünü seçer, WebSocket ve istek sıkıştırmasını kapatır. `/models` OpenAI biçiminde olduğundan Codex-native katalog bekleyen `model_catalog_url` kullanılmaz. Sağlayıcı bağlantısının kullanıcı ayarlarında tanımlanması [resmi yapılandırma rehberinde](https://learn.chatgpt.com/docs/config-file/config-advanced) açıklanır. Örnek düşünme düzeyini veya yerel erişim izinlerini değiştirmez.

20 Kasım 2026 canlı testinde web araması gerçek `web_search_call` ve kaynak gösterimiyle, ayrıca gerçek Codex CLI çağrısıyla doğrulandı. Fonksiyon çağrıları ve sonuçlarının geri gönderimi desteklenir; araçları bağlanan uygulama çalıştırır. Görsel girdi testi doğru renkleri tanıdı. Yerleşik web araması Responses API üzerinden geçer; Chat Completions ve Anthropic adaptörleri özel fonksiyon araçlarını destekler. Görsel üretimi sağlayıcıdan `403 Image generation is not enabled for this group` aldığı için örnekte kapalıdır; bir istemci özelliğini açmak sağlayıcı izni sağlamaz. ChatGPT/Codex istemcisindeki her özellik yalnızca model API'sine bağlı değildir.

## Kalıcı depolama ve güvenlik

Hesaplar, parola hash'leri, oturum hash'leri, API anahtarı hash'leri ve kotalar özel Vercel Blob deposunda saklanır. Tam parolalar veya tam API anahtarları kalıcı depoya yazılmaz. Okumalar `useCache:false` ile en son sürümü getirir; güncellemeler ETag `ifMatch` ile karşılaştırılıp yazılır. Aynı çalışan sunucudaki örtüşen değişiklikler, en çok 64 işlem içeren tek kalıcı yazımda birleştirilir; ayrı sunucular arasındaki çakışmalar güncel veri yeniden okunarak denenir. Her işlem kendi doğrulamasından geçer ve başarılı sonuçlar yalnızca kalıcı yazımdan sonra döner. Hatalı işlemler diğer işlemlere kısmi değişiklik sızdırmaz; depolama arızasında erişim kapalı kalır.

Bu depo, küçük ve davetli kullanıcı grupları için tek JSON kaydı kullanır. Kullanıcı üst sınırı, giriş denemesi sınırı, oturum ömrü ve kayıt boyutu kodda sınırlandırılmıştır. Daha yüksek trafik için aynı arayüz ilişkisel veritabanına taşınabilir.

Parolalar Node.js scrypt ile ayrı rastgele salt kullanılarak hash'lenir. Oturum çerezi Secure, HttpOnly ve SameSite=Strict'tir. Parola değişiminde eski oturumlar geçersiz olur. Yönetici işlemleri her istekte sunucuda yetki kontrolünden geçer; arayüzde düğme gizlemek tek başına yetkilendirme değildir. Kullanıcı bilgilerini değiştiren isteklere origin ve JSON boyut kontrolü uygulanır.

## Vercel kurulumu

Özel Blob deposunu projeye bağla:

```sh
vercel storage create klyapi-private --type blob --access private --region iad1
vercel storage connect klyapi-private --yes
vercel storage update klyapi-private --auth token --add-rw-token --environment production --yes
```

| Ortam değişkeni | Amaç |
| --- | --- |
| `BLOB_STORE_ID` | Bağlı özel Vercel Blob deposu |
| `BLOB_READ_WRITE_TOKEN` | Özel depoya yalnızca sunucudan erişim; tanımlıysa doğrudan bu kimlik kullanılır, aksi halde OIDC |
| `XINGCHI_API_KEY` | Yalnızca sunucuda kullanılan upstream API anahtarı |
| `KEY_HASH_SECRET` | Giriş denemesi anahtarlarını hash'lemek için ayrı rastgele sır |
| `ADMIN_USERNAME` | İlk yönetici kullanıcı adı, yalnızca ilk veri oluşturulurken |
| `ADMIN_PASSWORD_HASH` | İlk yöneticinin scrypt parola hash'i; düz parola değildir |
| `DEFAULT_OUTPUT_TOKENS` | İstemci çıktı limiti belirtmediğinde kullanılır; varsayılan 2048 |
| `MAX_OUTPUT_TOKENS` | İsteğe bağlı yönetici tavanı; tanımsızsa istemcinin geçerli pozitif tam sayı limiti aynen upstream'e iletilir |
| `UPSTREAM_AUTH_MODE` | `authorization` (varsayılan) veya `x-api-key` |

Başlangıç yönetici bilgileri kaynak kodunda bulunmaz. İlk veri oluşturulduktan sonra panelden yapılan parola değişiklikleri ortam değişkeniyle geri alınmaz. Sırlar `.gitignore` ve `.vercelignore` ile kaynak dağıtımından dışlanır.

Modelin çıktı sınırını upstream belirler. Proxy, açıkça verilen token limitlerine varsayılan bir tavan uygulamaz. Yönetici tavanı tanımlıysa, limitsiz istekler için varsayılan da bu tavana indirilir. Token ortam değişkenleri pozitif tam sayı olmalıdır; hatalı yapılandırma 503 döndürür.

Eşzamanlı kota yazımları ETag ile korunur. Depodan gelen hem ETag uyuşmazlığı hem de açıkça reddedilen koşullu yazma çakışması, güncel veri yeniden okunarak tekrar denenir; belirsiz ağ hatalarında yazma körlemesine tekrarlanmaz.

## İstemci uyumluluğu

Upstream'e Responses API biçiminde akışlı istek gönderilir; Chat Completions ve Anthropic Messages istek/yanıtları dönüştürülür. JSON isteyen istemcilerde tamamlanan yanıt birleştirilir; streaming isteyenler için olaylar ilgili protokole çevrilir. Kodlama istemcisi uyumlu başlıklarda KlyAPI geçidi belirtilir. Metin, görsel girdiler ve işlev araçları desteklenir. Ses, belge blokları veya dönüştürülemeyen seçenekler 400 hatası verir. Kesilen upstream akışları başarılıymış gibi gösterilmez.

Doğrulanmış `response.completed` veya `response.incomplete` olayı geldiğinde yanıt hemen sonlandırılır; sağlayıcının bağlantıyı kapatması ayrıca beklenmez. `/models` yalnızca sunulan `gpt-6.1-sol` modelini, mevcut anahtar ve dakika kotası kontrollerinden sonra doğrudan döndürür. Bu liste için sağlayıcıya ek ağ isteği gönderilmez.

`Server-Timing` yanıt başlığı `quota` ile kalıcı anahtar/kota kontrolünün, `upstream` ile sağlayıcıdan yanıt başlıkları alınana kadarki beklemenin milisaniye sürelerini gösterir. Başlıklar gönderildikten sonra biten aşamalar bu başlığa eklenemez. İlk gerçek metin ve toplam üretim süresi ayrıca ölçülmelidir; 8 saniyelik bağlantı bekleme verisi model yanıtı sayılmaz. Modelin düşünme ayarı değiştirilmez. Metnin tamamlanmadan görünmesi için istemci `stream: true` kullanabilir.

## Doğrulama

Uzun yanıtlar sırasında geçit 8 saniyede bir JSON öncesinde boşluk veya SSE yorum satırı göndererek kısa okuma zaman aşımına sahip istemcilerde bağlantıyı canlı tutar. Bunlar model çıktısı değildir. İlk bağlantı/giriş doğrulaması veya istemcinin toplam süre sınırı hâlâ zaman aşımına uğrayabilir; istemci tarafında 120 saniye veya üzeri süre önerilir. Bekleme verisi gönderildikten sonra HTTP durumu değiştirilemeyeceğinden geç oluşan hatalar yanıt gövdesindeki `error` alanında bildirilir. İstemciler HTTP 200 yanında `error` alanını da kontrol etmelidir. Bekleme başlamadan oluşan hatalar kendi HTTP durumlarını korur.

Geçici depolama okuma hataları ve kesin reddedilmiş yazma hız sınırları sınırlı olarak yeniden denenir. Sonucu belirsiz yazma hataları yeniden denenmez. Tanı kayıtları yalnızca aşama, HTTP durum kodu ve sabit hata sınıfı içerir; kullanıcı parolaları, API anahtarları ve istek gövdeleri kaydedilmez.

Node.js 20+ ile `npm test`. Testler yetkilendirme, parolalar, kullanıcı yönetimi, kişisel anahtarlar, eşzamanlı sayaçlar, ETag yeniden deneme, protokol dönüşümleri, SSE ve upstream hatalarını kapsar. Canlıya alırken giriş → anahtar oluşturma → gerçek model çağrısı → iptal akışı ayrıca doğrulanmalıdır.
