# KlyAPI

Vercel'de çalışan, yalnızca yöneticinin eklediği hesaplara açık API paneli.

## Kullanım

- `/login`: kullanıcı adı ve parola ile giriş. Herkese açık kayıt yoktur.
- `/key`: kişisel API anahtarı oluşturma, kopyalama, yenileme ve iptal.
- Panelde **Modeller**: aktif model kataloğunu ve desteklenen API yollarını gör.
- Panelde **Deneme alanı**: kişisel anahtarınla gerçek model yanıtını akış halinde izle; ilk metin, toplam süre ve çıktı token sayısını gör. Anahtar tarayıcıya kaydedilmez. Deneme modülü yalnızca bu sekme açıldığında yüklenir.
- Panelde **Kullanıcılar**: yönetici kullanıcı ekler, hesabı kapatır, parola sıfırlar ve dakika/saat/gün/hafta kotalarını ayarlar.
- Panelde **Şifre değiştir**: mevcut kullanıcı kendi parolasını değiştirir.
- OpenAI Base URL: `https://klyapi.vercel.app/api/v1`
- Anthropic Base URL: `https://klyapi.vercel.app/api`
- Modeller: `gpt-6.1-sol` ve `gpt-6-astra`; yalnızca sunucuda anahtarı tanımlanmış modeller katalogda yer alır.

Bir hesapta bir aktif API anahtarı bulunur; anahtar 30 gün geçerlidir ve tam değeri yalnızca oluşturma yanıtında gösterilir. Varsayılan kota dakikada 5, saatte 20, günde 50 ve haftada 200 üretim isteğidir. Yönetici bunları kullanıcı bazında değiştirebilir. Yenileme kullanım sayaçlarını sıfırlamaz. Model listesi dakika hız sınırına tabidir, ancak saatlik/günlük/haftalık üretim kotalarını tüketmez; başarısız upstream çağrılarında üretim kotası iade edilir. Saatlik ve günlük sayaçlar UTC sınırında, haftalık sayaç pazartesi UTC 00:00'da yenilenir. Kapatılmış kullanıcıların oturumları ve API anahtarları erişemez. Eski ortak sahip tokenı artık kabul edilmez.

## Codex masaüstü ve CLI

Paneldeki [kurulum rehberi](https://klyapi.vercel.app/key#setup), seçilen model için `config.toml` örneğini kopyalar veya indirir. Yeni oluşturulan kişisel `kly_` anahtarı bu sayfa açıkken kopyalama ve indirmeye eklenir; sonraki ziyaretlerde örnekteki yer tutucuyu kendi anahtarınla değiştir. Kaynak sağlayıcının anahtarı bu dosyaya veya tarayıcıya eklenmez.

Ayarları kullanıcı düzeyindeki `%USERPROFILE%\.codex\config.toml` (Windows) veya `~/.codex/config.toml` dosyasıyla birleştir; mevcut seçenekleri ve eklentileri koru, aynı TOML bölümünü iki kez tanımlama. Uygulamayı yeniden açıp yeni sohbet başlat. Örnek `KlyAPI` sağlayıcısını ve Responses protokolünü seçer. Uzun sohbetlerde geçmişin aşırı büyümemesi için `model_auto_compact_token_limit = 64000` ile daha erken otomatik özetleme önerir; düşünme düzeyi değişmez. WebSocket kapalıdır. Güncel Codex istemcisi özel sağlayıcılarda istek sıkıştırmasını kullanmadığı için bu özellik örnekte kapalı bırakılır. `/models` OpenAI biçiminde olduğundan Codex-native katalog bekleyen `model_catalog_url` kullanılmaz. Sağlayıcı bağlantısının kullanıcı ayarlarında tanımlanması [resmi yapılandırma rehberinde](https://learn.chatgpt.com/docs/config-file/config-advanced) açıklanır. Örnek düşünme düzeyini veya yerel erişim izinlerini değiştirmez.

21 Kasım 2026 testinde iki anahtarın model listeleri sırasıyla Sol ve Astra'yı döndürdü. Gerçek Codex istemcisiyle Sol üretimi başarılıydı. Astra üretimi sağlayıcıdan `403 insufficient dedicated balance for this group` aldı; panel son test için bakiye uyarısı gösterebilir. Bir modelin katalogda listelenmesi, sağlayıcı bakiyesi ve anlık kullanılabilirliğinin garantisi değildir. Her model yalnızca kendi sunucu anahtarını kullanır; Astra hiçbir durumda Sol anahtarına düşmez.

## Panelin yüklenmesi

Panel ve giriş sayfası tek `console.css` dosyasını yükler: önceki dört dosyanın toplamı 78.641 bayt, yeni dosya 30.152 bayttır (sıkıştırılmamış). İlk açılışta `/api/account`, oturumu ve hesap özetini tek yetkili depo okumasından döndürür. Kullanım yalnızca genel bakış görünürken en çok dakikada bir otomatik yenilenir; elle yenileme de vardır. Ağ hatasında son alınan veriler açıkça eski olarak işaretlenir. Sekmeler URL hash'i, geri/ileri ve doğrudan bağlantılarla çalışır; Ctrl/Cmd+K hızlı geçişi açar. Yönetici kullanıcıları ada ve erişim durumuna göre filtreleyebilir.

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
| `XINGCHI_SOL_API_KEY` | Sol için yalnızca sunucuda kullanılan kaynak anahtar |
| `XINGCHI_ASTRA_API_KEY` | Astra için ayrı kaynak anahtar; Sol anahtarı kullanılmaz |
| `XINGCHI_API_KEY` | İsteğe bağlı eski Sol anahtarı geri dönüşü |
| `XINGCHI_ASTRA_BALANCE_REQUIRED` | Son Astra testinin bakiye uyarısı; bakiye sonrası doğrulanınca kaldırılır |
| `KEY_HASH_SECRET` | Giriş denemesi anahtarlarını hash'lemek için ayrı rastgele sır |
| `ADMIN_USERNAME` | İlk yönetici kullanıcı adı, yalnızca ilk veri oluşturulurken |
| `ADMIN_PASSWORD_HASH` | İlk yöneticinin scrypt parola hash'i; düz parola değildir |
| `DEFAULT_OUTPUT_TOKENS` | İstemci çıktı limiti belirtmediğinde kullanılır; varsayılan 2048 |
| `MAX_OUTPUT_TOKENS` | İsteğe bağlı yönetici tavanı; tanımsızsa istemcinin geçerli pozitif tam sayı limiti aynen upstream'e iletilir |
| `UPSTREAM_AUTH_MODE` | `authorization` (varsayılan) veya `x-api-key` |

Başlangıç yönetici bilgileri kaynak kodunda bulunmaz. İlk veri oluşturulduktan sonra panelden yapılan parola değişiklikleri ortam değişkeniyle geri alınmaz. Sırlar `.gitignore` ve `.vercelignore` ile kaynak dağıtımından dışlanır.

Modelin çıktı sınırını upstream belirler. Proxy, açıkça verilen token limitlerine varsayılan bir tavan uygulamaz. Yönetici tavanı tanımlıysa, limitsiz istekler için varsayılan da bu tavana indirilir. Token ortam değişkenleri pozitif tam sayı olmalıdır; hatalı yapılandırma 503 döndürür.

Eşzamanlı kota yazımları ETag ile korunur. Depodan gelen hem ETag uyuşmazlığı hem de açıkça reddedilen koşullu yazma çakışması, güncel veri yeniden okunarak tekrar denenir; belirsiz ağ hatalarında yazma körlemesine tekrarlanmaz.

Blob SDK'nin kendi otomatik tekrarları kapalıdır; sınırlı okuma ve açık hız sınırı tekrarlarını depolama katmanı yönetir. Yazma yanıtı kaybolursa, iki saniyelik ayrı bir okuma bütçesi içinde hem benzersiz `commit_id` hem de tam veri karşılaştırılarak işlemin tamamlandığı doğrulanabilir. Eşleşme yoksa işlem 503 ile kapanır; kota veya oturum işlemi yeniden uygulanmaz. Girişte hız sınırı kontrolünden alınan özel kullanıcı özeti tekrar kullanılarak başarılı girişin depolama işlemleri beşten dörde indirilmiştir.

## İstemci uyumluluğu

Upstream'e Responses API biçiminde akışlı istek gönderilir; Chat Completions ve Anthropic Messages istek/yanıtları dönüştürülür. JSON isteyen istemcilerde tamamlanan yanıt birleştirilir; streaming isteyenler için olaylar ilgili protokole çevrilir. Kodlama istemcisi uyumlu başlıklarda KlyAPI geçidi belirtilir. Metin, görsel girdiler ve işlev araçları desteklenir. Ses, belge blokları veya dönüştürülemeyen seçenekler 400 hatası verir. Kesilen upstream akışları başarılıymış gibi gösterilmez.

Doğrulanmış `response.completed` veya `response.incomplete` olayı geldiğinde yanıt hemen sonlandırılır; sağlayıcının bağlantıyı kapatması ayrıca beklenmez. `/models` sunucuda tanımlanmış modelleri mevcut kişisel anahtar ve dakika kotası kontrollerinden sonra doğrudan döndürür. Bu liste için sağlayıcıya ek ağ isteği gönderilmez.

`Server-Timing` yanıt başlığı `quota` ile kalıcı anahtar/kota kontrolünün, `upstream` ile sağlayıcıdan yanıt başlıkları alınana kadarki beklemenin milisaniye sürelerini gösterir. Başlıklar gönderildikten sonra biten aşamalar bu başlığa eklenemez. İlk gerçek metin ve toplam üretim süresi ayrıca ölçülmelidir; 8 saniyelik bağlantı bekleme verisi model yanıtı sayılmaz. Modelin düşünme ayarı değiştirilmez. Metnin tamamlanmadan görünmesi için istemci `stream: true` kullanabilir.

## Büyük istekler ve 413

Eski 1 MB uygulama sınırı kaldırıldı. Sıkıştırılmamış veya sıkıştırılmış HTTP gövdesi en çok 4.400.000 bayt olabilir; zstd, gzip, deflate ve Brotli açıldıktan sonra JSON gövdesi en çok 16.000.000 bayttır. Sınırlar byte cinsindendir. Bozuk sıkıştırma 400, bilinmeyen veya üst üste kodlama 415, boyut aşımı 413 döndürür; kota ayrılmadan reddedilir. Varsayılan Vercel Functions gövde sınırı hâlâ geçerlidir. 4,4 MB üstü sıkıştırılmamış Codex geçmişinde yeni sohbet veya özetleme gerekir. Daha önceki örneği kullananlar güncel yapılandırmadan otomatik özetleme satırını ekleyebilir.

## Doğrulama

Uzun yanıtlar sırasında geçit 8 saniyede bir JSON öncesinde boşluk veya SSE yorum satırı göndererek kısa okuma zaman aşımına sahip istemcilerde bağlantıyı canlı tutar. Bunlar model çıktısı değildir. İlk bağlantı/giriş doğrulaması veya istemcinin toplam süre sınırı hâlâ zaman aşımına uğrayabilir; istemci tarafında 120 saniye veya üzeri süre önerilir. Bekleme verisi gönderildikten sonra HTTP durumu değiştirilemeyeceğinden geç oluşan hatalar yanıt gövdesindeki `error` alanında bildirilir. İstemciler HTTP 200 yanında `error` alanını da kontrol etmelidir. Bekleme başlamadan oluşan hatalar kendi HTTP durumlarını korur.

Geçici depolama okuma hataları ve kesin reddedilmiş yazma hız sınırları sınırlı olarak yeniden denenir. Sonucu belirsiz yazma hataları yeniden denenmez. Tanı kayıtları yalnızca aşama, HTTP durum kodu ve sabit hata sınıfı içerir; kullanıcı parolaları, API anahtarları ve istek gövdeleri kaydedilmez.

Node.js 24 ile `npm test`. Testler yetkilendirme, parolalar, kullanıcı yönetimi, kişisel anahtarlar, eşzamanlı sayaçlar, ETag yeniden deneme, protokol dönüşümleri, SSE ve upstream hatalarını kapsar. Canlıya alırken giriş → anahtar oluşturma → gerçek model çağrısı → iptal akışı ayrıca doğrulanmalıdır.
