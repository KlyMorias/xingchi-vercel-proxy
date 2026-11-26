# KlyAPI

Vercel'de çalışan, yalnızca yöneticinin eklediği hesaplara açık API paneli.

## Kullanım

- `/login`: kullanıcı adı ve parola ile giriş. Herkese açık kayıt yoktur.
- `/key`: en fazla 10 adlandırılmış proje anahtarı oluşturma, seçme, adını değiştirme ve ayrı ayrı iptal etme. Üstteki hızlı erişim alanı anahtar yönetimine, Base URL kopyalamaya ve deneme alanına ulaşır.
- Panelde **Modeller**: aktif model kataloğunu ve desteklenen API yollarını gör.
- Panelde **Deneme alanı**: kişisel anahtarınla gerçek model yanıtını akış halinde izle; ilk metin, toplam süre ve sağlayıcının bildirdiği giriş/çıkış/toplam token sayılarını gör. Eksik veya tutarsız kullanım bilgisi sayı uydurulmadan belirtilir. Anahtar tarayıcıya kaydedilmez. Deneme modülü yalnızca bu sekme açıldığında yüklenir.
- Panelde **İstek geçmişi**: kendi hesabına ait üretim denemelerini tarih, model, proje ve duruma göre filtrele; süreleri, hata kodlarını ve doğrulanmış tokenları incele veya eşleşen kayıtları CSV olarak indir.
- Panelde **Kullanıcılar**: yönetici kullanıcı ekler, hesabı kapatır, parola sıfırlar ve dakikalık kötüye kullanım hız sınırını ayarlar. Her hesabın günlük uygulama kotası 1 milyar tokendır; bu, sağlayıcı cüzdanı veya satın alınmış kredi değildir.
- Panelde **Şifre değiştir**: mevcut kullanıcı kendi parolasını değiştirir.
- OpenAI Base URL: `https://klyapi.vercel.app/api/v1`
- Anthropic Base URL: `https://klyapi.vercel.app/api`
- Modeller: `gpt-6.1-sol` ve `gpt-6-astra`; yalnızca sunucuda anahtarı tanımlanmış modeller katalogda yer alır.

Bir hesapta en fazla **10 aktif, adlandırılmış proje anahtarı** bulunur. Her anahtar oluşturulduğundan itibaren 30 gün geçerlidir ve tam değeri yalnızca oluşturma yanıtında gösterilir. Mevcut ve yeni tüm hesaplara her UTC günü **1.000.000.000 token günlük uygulama limiti** uygulanır; bu kota ve dakikalık hız sınırı hesabın bütün anahtarları arasında paylaşılır. Yeni bir anahtar oluşturmak kotayı artırmaz veya kullanımı sıfırlamaz. Bu limit sağlayıcıdan satın alınmış token, ücretsiz sağlayıcı kredisi veya dolar bakiyesi anlamına gelmez. Kullanım, sağlayıcının bildirdiği doğrulanmış giriş ve çıkış tokenlarının toplamıdır; bildirilmiş toplamın bu sayılarla eşleşmesi gerekir. Önbellek girişleri ve düşünme çıktıları bu toplamların alt kümesi olduğundan ayrıca eklenmez. Sağlayıcının cüzdan bakiyesi bu API tarafından bildirilmez; para cinsinden ücret veya ödeme sistemi yoktur. Önceki saatlik/günlük/haftalık istek kotaları artık uygulanmaz. Dakikalık kötüye kullanım hız sınırı varsayılan 5 istektir ve yönetici tarafından hesap bazında değiştirilebilir.

Üretim çağrısı başlamadan önce tahmini token bütçesi atomik olarak ayrılır; bu rezervasyon gerçek tüketim değildir. Doğrulanmış terminal yanıttaki gerçek kullanım rezervasyonu tek seferde kapatır; başarısız terminal yanıt geçerli kullanım bildiriyorsa bu da kaydedilir. Eşzamanlı çağrılar ayrılmış bütçeyi harcayamaz. Sağlayıcıya ulaşmadan iptal edilen isteklerin rezervasyonu iade edilir. Kesilen veya geçersiz kullanım döndüren isteklerin tüketimi bilinmiyor olarak işaretlenir; sıfır veya tahmin gerçek tüketim yerine yazılmaz. Bütçe tutuşu 10 dakika sonra kalkar, geç gelen gerçek kullanımın işlenebilmesi için mutabakat kaydı 1 saat tutulur; belirsiz kayıt silinse bile günlük eksik kayıt uyarısı korunur. Başarılı mutabakat kimlikleri tekrarlı yazımlarda çift ücretlemeyi önlemek için 10 dakika tutulur. Gerçek kullanım tahmini aşarsa gerçek sayı kaydedilir ve kalan kota sıfırda sınırlandırılır. Panel; kayıt kaynağını, son sağlayıcı yanıtının token makbuzunu, doğrulanmış dağılımı ve geçici rezervasyonu gösterir. Eksik kayıt varsa bilinen tüketim alt sınır olarak gösterilir; kalan kota doğrulanmış gibi sunulmaz. Günlük kota UTC 00:00'da yenilenir; gece yarısını aşan çağrı başladığı güne aittir. Model listesi dakika hız sınırına tabidir, token tüketmez. Anahtar yenilemek kullanımı sıfırlamaz. Kapatılmış kullanıcıların oturumları ve API anahtarları erişemez. Eski ortak sahip tokenı artık kabul edilmez.

## Proje anahtarları

Anahtarlarını `Web sitesi`, `Codex` veya `Test` gibi proje adlarıyla ayırabilirsin. Her proje satırı kendi kaydedilmiş günlük giriş/çıkış tokenlarını, oluşturulma ve geçerlilik bilgisini gösterir. Anahtarın adını değiştirmek kimlik bilgisini değiştirmez; birini iptal etmek diğerlerini etkilemez. Eski tek anahtarlı hesapların mevcut `kly_` anahtarları geçerliliğini korur ve `Kişisel anahtar` adıyla görünür; bu özellik için hesap veya anahtar sıfırlanmaz.

**Yeni sürüm oluştur** önce ikinci bir anahtar oluşturur; eski anahtar kendiliğinden silinmez veya iptal edilmez. Yeni tam değeri bir kez güvenli biçimde kaydet, bağlı uygulamanı yeni anahtara geçir, çalıştığını doğrula ve ardından eski anahtarı açıkça iptal et. Her iki anahtarın aktif olduğu geçiş süresi de 10 anahtar sınırına dahildir. Tam anahtarlar kalıcı depoda ve tarayıcı depolamasında tutulmaz; sonraki ziyaretlerde yalnızca maskelenmiş önek ve yönetim kimliği bulunur.

Proje kullanım takibi başlamadan önceki hesap toplamları bir anahtara tahminen atanmaz. Eski bir anahtarın izlemeye başladığı UTC gününde eksik geçmiş açıkça belirtilir. Daha sonraki tam izlenen UTC günlerinin sayıları bu eski belirsizlik nedeniyle eksik gösterilmez; o günkü yeni doğrulanamayan istekler ayrıca belirtilir. İzleme öncesi geçmişin bilinmediği bilgisi korunur.

Panel oturumu gerektiren anahtar uç noktası `GET /api/keys` ile kendi anahtarlarının üst verisini döndürür. `POST /api/keys` JSON `{ "name": "Web sitesi" }` ile oluşturur; tam `api_key` yalnızca bu yanıtta gelir. `PATCH /api/keys` JSON `{ "id": "key_…", "name": "Yeni ad" }` ile yeniden adlandırır; `DELETE /api/keys` JSON `{ "id": "key_…" }` ile yalnızca belirtilen anahtarı iptal eder. Buradaki `key_…`, listeden alınan yönetim kimliğidir; gizli `kly_…` değeri değildir. Değişiklikler aynı origin ve JSON denetiminden geçer. Birden fazla aktif anahtar varken kimliksiz iptal isteği 409 ile reddedilir; toplu iptal olarak yorumlanmaz.

## İstek geçmişi ve gözlenen model durumu

`GET /api/activity` geçerli panel oturumuyla yalnızca o hesaba ait kayıtları döndürür; kişisel API anahtarıyla Bearer doğrulaması bu yönetim uç noktasının oturumu yerine geçmez. Yönetici de bu uç noktadan başka hesapların isteklerini göremez. Yanıtlar `private, no-store` ile sunulur.

Geçerli anahtar, gövde ve model doğrulamasından sonra kota kontrolüne ulaşan üretim denemeleri bu sürümden itibaren kaydedilir. Kota tarafından reddedilen denemeler de durumlarıyla görünür; model listesi GET çağrıları ve daha önce reddedilen geçersiz istekler bu üretim geçmişinin parçası değildir. **Eski isteklerin ayrıntıları geriye dönük oluşturulmaz.** Kayıtlar en yeni başlangıç zamanına göre sıralanır.

| Sorgu alanı | Anlamı |
| --- | --- |
| `from`, `to` | `YYYY-AA-GG` biçiminde başlangıç ve bitiş günü; sınırlar UTC'dir ve bitiş günü dahildir. Paneldeki satır saatleri cihazın yerel saatinde gösterilir |
| `model` | Model kimliğiyle tam eşleşme |
| `key_id` | Proje anahtarının yönetim kimliğiyle tam eşleşme; iptal edilmiş anahtarların saklanan kayıtları da filtrelenebilir |
| `status` | `in_progress`, `success`, `error`, `cancelled` veya `unknown` |
| `limit` | JSON sayfa boyutu; varsayılan 25, en az 1 ve en çok 100 |
| `cursor` | Önceki yanıttaki `next_cursor`; aynı filtrelerle sonraki sayfayı getirir |
| `format` | `json` (varsayılan) veya `csv` |

JSON yanıtında `items`, `next_cursor`, filtrelere uyan saklanmış kayıt sayısı `total`, `retention`, filtre seçenekleri `filters` ve hesaba ait `model_health` bulunur. Örnek: `GET /api/activity?status=error&from=2026-11-26&to=2026-11-26&limit=25`. `format=csv`, yalnızca görünen JSON sayfasını değil, aynı filtrelere uyan saklanmış kayıtların tamamını indirir. CSV hücreleri tırnaklanır ve formül olarak yorumlanabilecek metin başlangıçları etkisizleştirilir.

Saklama sınırları birlikte uygulanır: **son 30 gün, hesap başına en fazla 200 kayıt ve hizmet genelinde en fazla 2.000 kayıt**. Dolayısıyla yoğun kullanımda 30 gün dolmadan eski kayıtlar çıkarılabilir; hesap başına 200 kayıt tutulacağı garanti edilmez. Dışa aktarma da yalnızca halen saklanan kayıtları içerir. Bu sınırlar hesap kotasını veya daha önce kaydedilmiş gerçek token toplamlarını sıfırlamaz.

İstek geçmişinde yalnızca üst veri tutulur: istek/yanıt kimliği, zamanlar, model, o isteğin proje kimliği ve adı, API yolu, durum, HTTP durumu, sabit hata kodu, ölçülen süre ve doğrulanmış giriş/çıkış/toplam tokenları. **Mesajlar, yanıt içerikleri, ham sağlayıcı hata metinleri, kimlik doğrulama başlıkları, tam anahtarlar ve IP adresleri bu geçmişe yazılmaz.** Kullanım doğrulanamadığında token alanları `null` olur; sıfır veya tahmini sayı tüketim yerine yazılmaz. Başarısız ya da iptal edilmiş bir yanıt doğrulanmış kullanım bildirdiyse gerçek tokenları korunur. Akış veya bekleme verisi başladıktan sonra oluşan hata, HTTP 200 yanında kayıt durumunda `error` olarak görünebilir.

Modellerdeki gözlenen durum, yalnızca hesabının bu saklama aralığındaki son başarılı yanıtını ve son başarısız/iptal/belirsiz denemesini gösterir. Filtre veya sayfa seçimi bu hesap gözlemini değiştirmez. Gözlem yoksa test edilmiş gibi gösterilmez; bu alan hizmet genelinde çalışma süresi, sağlayıcı bakiyesi, performans garantisi veya sürekli sağlık kontrolü değildir. Durum göstermek için ayrı ücretli model denemesi gönderilmez. Geçmişin kaydı mevcut rezervasyon/mutabakat yazımlarının içinde yapılır; normal üretim yoluna ayrı bir geçmiş veritabanı yazımı eklenmez.

## Codex masaüstü ve CLI

Paneldeki [kurulum rehberi](https://klyapi.vercel.app/key#setup), seçilen model için `config.toml` örneğini kopyalar veya indirir. Yeni oluşturulan kişisel `kly_` anahtarı bu sayfa açıkken kopyalama ve indirmeye eklenir; sonraki ziyaretlerde örnekteki yer tutucuyu kendi anahtarınla değiştir. Kaynak sağlayıcının anahtarı bu dosyaya veya tarayıcıya eklenmez.

Ayarları kullanıcı düzeyindeki `%USERPROFILE%\.codex\config.toml` (Windows) veya `~/.codex/config.toml` dosyasıyla birleştir; mevcut seçenekleri ve eklentileri koru, aynı TOML bölümünü iki kez tanımlama. Uygulamayı yeniden açıp yeni sohbet başlat. Örnek `KlyAPI` sağlayıcısını ve Responses protokolünü seçer. Uzun sohbetlerde geçmişin aşırı büyümemesi için `model_auto_compact_token_limit = 64000` ile daha erken otomatik özetleme önerir; düşünme düzeyi değişmez. WebSocket kapalıdır. Güncel Codex istemcisi özel sağlayıcılarda istek sıkıştırmasını kullanmadığı için bu özellik örnekte kapalı bırakılır. `/models` OpenAI biçiminde olduğundan Codex-native katalog bekleyen `model_catalog_url` kullanılmaz. Sağlayıcı bağlantısının kullanıcı ayarlarında tanımlanması [resmi yapılandırma rehberinde](https://learn.chatgpt.com/docs/config-file/config-advanced) açıklanır. Örnek düşünme düzeyini veya yerel erişim izinlerini değiştirmez.

21 Kasım 2026 testinde iki anahtarın model listeleri sırasıyla Sol ve Astra'yı döndürdü. Gerçek Codex istemcisiyle Sol üretimi başarılıydı. Astra üretimi sağlayıcıdan `403 insufficient dedicated balance for this group` aldı; panel son test için bakiye uyarısı gösterebilir. Bir modelin katalogda listelenmesi, sağlayıcı bakiyesi ve anlık kullanılabilirliğinin garantisi değildir. Her model yalnızca kendi sunucu anahtarını kullanır; Astra hiçbir durumda Sol anahtarına düşmez.

## Uzun konuşmalarda sağlayıcının tur sınırı

Sağlayıcının `session_turn_limit_exceeded` hatası yalnızca kullanıcı/assistant mesajlarını değil, geçmiş fonksiyon ve özel araç çağrılarını da sayar. Proxy, dönüştürülmüş Responses geçmişinde en az 90 model kaydı bulunduğunda eski ve tamamlanmış metin/araç kayıtlarını kullanıcı rolünde açıkça güvenilmeyen JSON arşivine katlar. Orijinal roller, metinler ve araç kimlikleri arşivde veri olarak tutulur; son 20 veya daha fazla model kaydı, en yeni kullanıcı mesajı ve açık araç zincirleri normal biçimlerini korur. Sistem/developer talimatları, üst düzey `instructions` ve bilinen opak reasoning/compaction kayıtları değiştirilmez. Başarılı katlama `X-KlyAPI-History: folded` başlığıyla bildirilir.

Bu işlem ek bir model çağrısı veya anlamsal özetleme yapmaz; token bağlamını küçülttüğü ya da modelin eski veriyi her zaman kusursuz kullanacağı garanti edilmez. Arşivlerin toplam sınırı 4 MiB'dir. Bilinen kullanıcı görsel/dosya kayıtları arşive çevrilmeden kendi konumlarında korunur; çevrelerindeki tamamlanmış metin/araç kayıtları katlanabilir. Bilinmeyen kayıt türleri, eksik/bozuk araç eşleşmeleri veya güvenle katlanamayan geçmiş aynen iletilir. Sağlayıcı yine tam olarak bu tur-sınırı kodunu döndürürse hata, istemcinin bağlam hatası olarak tanıyabilmesi için standart `context_length_exceeded` koduyla ve `/compact` veya `/new` yönlendirmesiyle verilir. Diğer hatalar bu koda çevrilmez. Normal kısa istekler ek model çağrısı olmadan mevcut yolu kullanır.

## Panelin yüklenmesi

Panel ve giriş sayfası `console.css`, fotoğraflı Studio görünümü için `studio.css`, çalışma alanı düzeni için `workspace-refinements.css` ve özgün bağlantı monogramı için `identity.css` kullanır. Manrope yazı tipi ve siyah-beyaz mimari fotoğraf aynı origin'den sunulur; `<picture>` küçük ekranlar için ayrı fotoğraf seçer. Geniş ekranda sol gezinme şeridi, üstte hızlı bağlantı alanı ve anahtar/fotoğraf çalışma yüzeyi bulunur; telefonda alt gezinme ve tek sütuna uyarlanan paneller kullanılır. Açılış ve kaydırma hareketleri küçük, bağımsız `motion.js` modülüyle çalışır; ekran dışındaki fotoğraf hareketleri durur, azaltılmış hareket tercihi korunur ve hareket modülü yüklenemediğinde içerik gizlenmez. Fotoğraf kaynak ve lisans bilgileri `assets/architecture-hero.LICENSE.txt` dosyasındadır. İlk açılışta `/api/account`, oturumu ve hesap özetini tek yetkili depo okumasından döndürür. Kullanım yalnızca genel bakış görünürken en çok dakikada bir otomatik yenilenir; elle yenileme de vardır. Ağ hatasında son alınan veriler açıkça eski olarak işaretlenir. İstek geçmişi açıldığında yüklenir; süreli önbelleği, elle yenilemesi ve sayfalaması vardır. Sekmeler URL hash'i, geri/ileri ve doğrudan bağlantılarla çalışır; Ctrl/Cmd+K hızlı geçişi açar. Yönetici kullanıcıları ada ve erişim durumuna göre filtreleyebilir.

20 Kasım 2026 canlı testinde web araması gerçek `web_search_call` ve kaynak gösterimiyle, ayrıca gerçek Codex CLI çağrısıyla doğrulandı. Fonksiyon çağrıları ve sonuçlarının geri gönderimi desteklenir; araçları bağlanan uygulama çalıştırır. Görsel girdi testi doğru renkleri tanıdı. Yerleşik web araması Responses API üzerinden geçer; Chat Completions ve Anthropic adaptörleri özel fonksiyon araçlarını destekler. Görsel üretimi sağlayıcıdan `403 Image generation is not enabled for this group` aldığı için örnekte kapalıdır; bir istemci özelliğini açmak sağlayıcı izni sağlamaz. ChatGPT/Codex istemcisindeki her özellik yalnızca model API'sine bağlı değildir.

## Kalıcı depolama ve güvenlik

Hesaplar, parola hash'leri, oturum hash'leri, API anahtarı hash'leri ve proje üst verileri, kotalar ve sınırlandırılmış istek geçmişi üst verileri seçili kalıcı depoda saklanır. `DATABASE_URL` tanımlıysa birincil depo PostgreSQL'dir; yalnızca bu değişken tanımlı değilse özel Vercel Blob yolu seçilir. PostgreSQL bağlantısı, sorgusu, şeması veya verisi hatalı olduğunda Blob'a otomatik geçiş yapılmaz; erişim kapalı kalır. Tam parolalar veya tam API anahtarları kalıcı depoya yazılmaz.

Her iki backend aynı, en fazla 4.000.000 UTF-8 baytlık JSON hesap snapshot'ını kullanır. PostgreSQL bunu `public.klyapi_state` tablosundaki tek kaydın `payload TEXT` alanında tutar. `BIGINT` sürümü hassasiyet kaybını önlemek için metin olarak okunur ve ETag arayüzüne aktarılır; güncelleme, beklenen sürümü koşul olarak kullanan atomik compare-and-swap (CAS) ile sürümü artırır. Blob geri dönüş modunda okumalar `useCache:false` ile en son sürümü getirir; güncellemeler ETag `ifMatch` koşuluyla yazılır. Aynı çalışan sunucudaki örtüşen değişiklikler, en çok 64 işlem içeren tek kalıcı yazımda birleştirilir; ayrı sunucular arasındaki çakışmalar güncel veri yeniden okunarak denenir. Her işlem kendi doğrulamasından geçer ve başarılı sonuçlar yalnızca kalıcı yazımdan sonra döner. Hatalı işlemler diğer işlemlere kısmi değişiklik sızdırmaz.

PostgreSQL erişimi yalnızca sunucuda, resmi Neon sürücüsünün HTTPS SQL yolu ve parametreli sorgularla yapılır. Tek sorgu en fazla 10 saniyelik, depolama işlemleri sınırlı toplam süre bütçesiyle çalışır; iptal sinyali sürücüye iletilir. Bağlantı dizgesi, SQL, parametreler ve hesap verisi içerebilen ham sürücü hataları dışarı verilmez. Sonucu belirsiz yazmalar körlemesine tekrarlanmaz. Kullanıcı üst sınırı, giriş denemesi sınırı, oturum ömrü ve kayıt boyutu kodda sınırlandırılmıştır; bu sürüm hesapları ayrı ilişkisel satırlara ayırmaz.

PostgreSQL şeması ve ilk snapshot açık bir başlatma/geçiş işlemiyle hazırlanmalıdır. Normal istekler otomatik DDL çalıştırmaz ve PostgreSQL'e başlangıç yöneticisi veya boş hesap verisi eklemez. Tablo ya da tek hesap kaydı eksikse istek 503 ile kapanır; mevcut veri kendiliğinden yeniden oluşturulmaz.

Parolalar Node.js scrypt ile ayrı rastgele salt kullanılarak hash'lenir. Oturum çerezi Secure, HttpOnly ve SameSite=Strict'tir. Parola değişiminde eski oturumlar geçersiz olur. Yönetici işlemleri her istekte sunucuda yetki kontrolünden geçer; arayüzde düğme gizlemek tek başına yetkilendirme değildir. Kullanıcı bilgilerini değiştiren isteklere origin ve JSON boyut kontrolü uygulanır.

## Vercel kurulumu

Önerilen PostgreSQL yolunda Neon bağlantı dizgesini yalnızca sunucunun `DATABASE_URL` ayarı olarak kullan. Etkinleştirmeden önce:

1. Açık başlatma/geçiş adımında `lib/postgres-blob.js` içindeki `CREATE_TABLE_SQL` ile şemayı oluştur.
2. Erişilebilir mevcut deponun doğrulanmış snapshot'ını, yalnızca hedef kayıt yokken koşullu olarak ekle. Yeni boş kurulum açıkça onaylandıysa ilk yönetici snapshot'ını mevcut `ADMIN_USERNAME` ve `ADMIN_PASSWORD_HASH` ayarlarıyla ayrı bir başlatma adımında oluştur; bu işlem normal istek yolunun parçası değildir. Var olan kaydı koşulsuz ezme.
3. Hedefteki veriyi ve sürümü yeniden okuyup doğrula; sonra Vercel ve büyük istek geçidini aynı `DATABASE_URL` ile etkinleştir. Eski depoyu silme. Eski snapshot'a erişilemiyorsa kullanıcılar ve anahtarlar aktarılmış sayılmaz; yeni kurulumda yeniden oluşturulmaları gerekir.
4. Giriş, anahtar oluşturma, gerçek model çağrısı, kullanım/kota hesabı ve iptal akışını canlıda ayrıca doğrula.

25 Kasım 2026 durumu: kullanıcı onayıyla yeni Neon deposu başlangıç yönetici kaydıyla oluşturuldu ve hem Vercel hem Render üzerinde etkinleştirildi. Eski Blob verisi aktarılmadı ve değiştirilmeden korundu; eski kullanıcılar ve API anahtarları yeniden oluşturulmalıdır. Üretim API'sinde 101 tamamlanmış araç turu içeren geçmişle Sol SSE yanıtı, doğrudan Render üretimi ve toplam 21.769 tokenın kalıcı kotaya tam işlenmesi doğrulandı; açık rezervasyon kalmadı. Aynı Vercel adresinden Content-Length içeren tam 50 MiB gövde uygulama doğrulamasına ulaştı. Test kayıtları temizlendi; ayrı salt-okunur kontrolde başlangıç yöneticisi korunmuş, diğer hesap/anahtar/kota kayıtları boş bulundu. Bunlar tekil sentetik doğrulamalardır; 101 ardışık canlı istek, model bağlam kapasitesi veya hız garantisi değildir.

Yalnızca `DATABASE_URL` kullanmayacaksan özel Blob deposunu isteğe bağlı geri dönüş backend'i olarak projeye bağla:

```sh
vercel storage create klyapi-private --type blob --access private --region iad1
vercel storage connect klyapi-private --yes
vercel storage update klyapi-private --auth token --add-rw-token --environment production --yes
```

| Ortam değişkeni | Amaç |
| --- | --- |
| `DATABASE_URL` | Yalnızca sunucuda kullanılan Neon PostgreSQL bağlantı dizgesi; tanımlıysa birincil ve tek seçilen backend. Şema ve ilk snapshot önceden açık başlatma/geçişle hazırlanmalıdır |
| `BLOB_STORE_ID` | Yalnızca `DATABASE_URL` tanımlı değilken kullanılan bağlı özel Vercel Blob deposu |
| `BLOB_READ_WRITE_TOKEN` | Yalnızca Blob modunda, özel depoya sunucudan erişim; tanımlıysa doğrudan bu kimlik kullanılır, aksi halde OIDC |
| `XINGCHI_SOL_API_KEY` | Sol için yalnızca sunucuda kullanılan kaynak anahtar |
| `XINGCHI_ASTRA_API_KEY` | Astra için ayrı kaynak anahtar; Sol anahtarı kullanılmaz |
| `XINGCHI_API_KEY` | İsteğe bağlı eski Sol anahtarı geri dönüşü |
| `XINGCHI_ASTRA_BALANCE_REQUIRED` | Son Astra testinin bakiye uyarısı; bakiye sonrası doğrulanınca kaldırılır |
| `KEY_HASH_SECRET` | Giriş denemesi anahtarlarını hash'lemek için ayrı rastgele sır |
| `ADMIN_USERNAME` | İlk yönetici kullanıcı adı; PostgreSQL için açık başlatma adımında, Blob modunda yalnızca ilk veri oluşturulurken |
| `ADMIN_PASSWORD_HASH` | İlk yöneticinin scrypt parola hash'i; düz parola değildir. PostgreSQL isteği bu ayarla otomatik veri oluşturmaz |
| `DEFAULT_OUTPUT_TOKENS` | İstemci çıktı limiti belirtmediğinde kullanılır; varsayılan 2048 |
| `MAX_OUTPUT_TOKENS` | İsteğe bağlı yönetici tavanı; tanımsızsa istemcinin geçerli pozitif tam sayı limiti aynen upstream'e iletilir |
| `UPSTREAM_AUTH_MODE` | `authorization` (varsayılan) veya `x-api-key` |

Başlangıç yönetici bilgileri kaynak kodunda bulunmaz. İlk veri oluşturulduktan sonra panelden yapılan parola değişiklikleri ortam değişkeniyle geri alınmaz. Sırlar `.gitignore` ve `.vercelignore` ile kaynak dağıtımından dışlanır.

Modelin çıktı sınırını upstream belirler. Proxy, açıkça verilen token limitlerine varsayılan bir tavan uygulamaz. Yönetici tavanı tanımlıysa, limitsiz istekler için varsayılan da bu tavana indirilir. Token ortam değişkenleri pozitif tam sayı olmalıdır; hatalı yapılandırma 503 döndürür.

Eşzamanlı kota yazımları PostgreSQL'de sürüm CAS'i, Blob modunda ETag ile korunur. Sürüm/ETag uyuşmazlığı ve açıkça reddedilen koşullu yazma çakışması, güncel veri yeniden okunarak tekrar denenir; belirsiz ağ hatalarında yazma körlemesine tekrarlanmaz.

Blob geri dönüş modunda SDK'nin kendi otomatik tekrarları kapalıdır; her iki backend'de sınırlı okuma ve açık hız sınırı tekrarlarını ortak depolama katmanı yönetir. Yazma yanıtı kaybolursa, iki saniyelik ayrı bir okuma bütçesi içinde hem benzersiz `commit_id` hem de tam veri karşılaştırılarak işlemin tamamlandığı doğrulanabilir. Eşleşme yoksa işlem 503 ile kapanır; kota veya oturum işlemi yeniden uygulanmaz. Girişte hız sınırı kontrolünden alınan özel kullanıcı özeti tekrar kullanılarak başarılı girişin depolama işlemleri beşten dörde indirilmiştir.

## İstemci uyumluluğu

Upstream'e Responses API biçiminde akışlı istek gönderilir; Chat Completions ve Anthropic Messages istek/yanıtları dönüştürülür. JSON isteyen istemcilerde tamamlanan yanıt birleştirilir; streaming isteyenler için olaylar ilgili protokole çevrilir. Kodlama istemcisi uyumlu başlıklarda KlyAPI geçidi belirtilir. Metin, görsel girdiler ve işlev araçları desteklenir. Ses, belge blokları veya dönüştürülemeyen seçenekler 400 hatası verir. Kesilen upstream akışları başarılıymış gibi gösterilmez.

Doğrulanmış `response.completed` veya `response.incomplete` olayı geldiğinde yanıt hemen sonlandırılır; sağlayıcının bağlantıyı kapatması ayrıca beklenmez. `/models` sunucuda tanımlanmış modelleri mevcut kişisel anahtar ve dakika kotası kontrollerinden sonra doğrudan döndürür. Bu liste için sağlayıcıya ek ağ isteği gönderilmez.

`Server-Timing` yanıt başlığı `quota` ile kalıcı anahtar/kota kontrolünün, `upstream` ile sağlayıcıdan yanıt başlıkları alınana kadarki beklemenin milisaniye sürelerini gösterir. Başlıklar gönderildikten sonra biten aşamalar bu başlığa eklenemez. İlk gerçek metin ve toplam üretim süresi ayrıca ölçülmelidir; 8 saniyelik bağlantı bekleme verisi model yanıtı sayılmaz. Modelin düşünme ayarı değiştirilmez. Metnin tamamlanmadan görünmesi için istemci `stream: true` kullanabilir.

## Büyük istekler ve 413

Vercel Functions girişinde uygulamanın aktarım sınırı 4.400.000 bayttır; zstd, gzip, deflate ve Brotli açıldıktan sonra JSON sınırı 64 MiB'dir. Vercel isteği işleve ulaşmadan reddedebilir: yalnızca uygulamadaki sayıyı büyütmek `FUNCTION_PAYLOAD_TOO_LARGE` hatasını çözmez. Vercel'in yeni 20 MiB isteğe bağlı sınırı da 50 MB hedefinin altındadır. Bozuk sıkıştırma 400, bilinmeyen veya üst üste kodlama 415, boyut aşımı 413 döndürür; kota ayrılmadan reddedilir.

`npm start` ile çalışan ayrı Node.js 24 geçidi, **toplam HTTP/JSON gövdesinde 50 MiB (52.428.800 bayt)** kabul eder; base64 görseller ve JSON alanları bu toplama dahildir. Sıkıştırılmış gövde de, açılmış JSON da bu sınırı geçemez. Aynı kişisel anahtarları ve kotayı paylaşması için Vercel ile aynı kalıcı backend'e yapılandırılmalıdır: `DATABASE_URL` tanımlıysa aynı PostgreSQL veritabanı, tanımlı değilse aynı özel Blob deposu. PostgreSQL hatasında Blob'a geçmez. Gerçek token hesabı ve Responses / Chat Completions / Messages akışları korunur. Varsayılan tek eşzamanlı POST, okuma öncesi anahtar doğrulaması, bellek toplama ve JSON karmaşıklık sınırları küçük sunucuda bellek kullanımını sınırlar.

Render Free hizmeti `https://klyapi-large-requests.onrender.com` adresinde kurulmuştur. 25 Kasım 2026 doğrudan canlı doğrulamasında **16/16 kontrol** geçti: tam 50 MiB Content-Length aktarımı `14375 ms`, chunked aktarım `13396 ms` sürdü; küçük gerçek Sol JSON/SSE üretimi ve paylaşılan token kotası da doğrulandı. Koşullu yönlendirme mevcut `klyapi.vercel.app` üretim adresine yayımlandı ve **üretimde 50 MiB Content-Length taşımasının 4/4 kontrolü geçti**: gövde uygulamaya ulaştı, `X-KlyAPI-Ingress: large` işaretiyle bilerek geçersiz modelin beklenen `400` yanıtı döndü, `413` oluşmadı ve kota tüketilmedi. İstemciden ölçülen `71245 ms` toplamının büyük kısmı gövdenin istemci tarafından yazımını içerir; sunucu işlem süresi veya hız garantisi değildir. Büyük gövde taşıma testi, modelin aynı boyutta bağlamdan üretim yapabildiğinin garantisi değildir.

`vercel.json`, mevcut rewrite'ları koruyarak yalnızca üretim yollarındaki POST'ları iki koşulla Render'a yollar: `Content-Length > 4400000` veya bu başlığın bulunmaması. Bilinen küçük gövdeler (`≤ 4400000` bayt), model listeleri ve OPTIONS Vercel'de kalır; normal API kullanımı Render'ın soğuk başlangıcına ve büyük istek için tek eşzamanlılık sınırına bağlanmaz. Harici yoldan dönen yanıtta `X-KlyAPI-Ingress: large` başlığı vardır. OpenAI ve Anthropic base URL'leri ile mevcut kişisel anahtarlar değişmez.

Üretim base URL'siyle gerçek Codex CLI doğrulaması da **4/4 kontrolle** geçti; tamamlanmış model yanıtının başarı işareti istemcide `8399 ms` içinde görüldü. Sağlayıcının bildirdiği `17123` giriş ve `8` çıkış tokenı tam olarak hesaba işlendi, açık rezervasyon `0` kaldı. Bu tek çağrı süresi bir hız garantisi değildir.

Uzunluğu bilinmeyen POST için kuralın dış hedef seçmesi, her aktarım biçiminin Vercel zincirinden başarıyla geçtiğinin garantisi değildir. Doğrudan Render'da chunked 50 MiB geçerken, Vercel üzerinden HTTP/1.1 chunked ve üretimde HTTP/2 Content-Length'siz 50 MiB denemeleri Node başlangıç kaydı olmadan `502` verdi. Bu nedenle **Vercel üzerinden uzunluğu bilinmeyen büyük yüklemelerin başarısı garanti edilmez**; üretimde doğrulanan 50 MiB yol doğru Content-Length taşıyan gövdedir. Hazır JSON gövdesinin gerçek bayt sayısı biliniyorsa istemci doğru `Content-Length` göndermelidir.

Ücretsiz Render 15 dakika kullanılmazsa uyur; büyük veya uzunluğu bilinmeyen sonraki istekte yaklaşık bir dakika, 50 saniye veya üzeri ilk açılış gecikmesi olabilir. Aylık kullanım kotaları da vardır. Depodaki `render.yaml` açıkça `plan: free` seçer; Docker alternatifi de hazırdır. Ayrıntılı kurulum, koşullu yönlendirme ve doğrulama: [Büyük istek geçidi](docs/large-requests.md).

## Doğrulama

Uzun yanıtlar sırasında geçit 8 saniyede bir JSON öncesinde boşluk veya SSE yorum satırı göndererek kısa okuma zaman aşımına sahip istemcilerde bağlantıyı canlı tutar. Bunlar model çıktısı değildir. İlk bağlantı/giriş doğrulaması veya istemcinin toplam süre sınırı hâlâ zaman aşımına uğrayabilir; istemci tarafında 120 saniye veya üzeri süre önerilir. Bekleme verisi gönderildikten sonra HTTP durumu değiştirilemeyeceğinden geç oluşan hatalar yanıt gövdesindeki `error` alanında bildirilir. İstemciler HTTP 200 yanında `error` alanını da kontrol etmelidir. Bekleme başlamadan oluşan hatalar kendi HTTP durumlarını korur.

Geçici depolama okuma hataları ve kesin reddedilmiş yazma hız sınırları sınırlı olarak yeniden denenir. Sonucu belirsiz yazma hataları yeniden denenmez. Proxy tanıları yalnızca aşama, HTTP durum kodu ve sabit hata sınıfı içerir. Üretim geçidinin yükleme tanıları süreç içi sayısal istek kimliği, sabit yaşam döngüsü aşaması, geçen süre, beyan edilen gövde boyutu, chunked/100-continue işaretleri ve HTTP durumunu kaydeder; gövdeyi okumadan bağlantının nerede kesildiğini ayırmaya yardımcı olur. Kullanıcı parolaları, API anahtarları, istek içeriği, IP, hesap kimliği veya sorgu değerleri bu uygulama tanılarına yazılmaz; platform erişim günlükleri ayrı tutulur.

Node.js 24 ile `npm test`. Testler yetkilendirme, parolalar, kullanıcı yönetimi, kişisel anahtarlar, eşzamanlı sayaçlar, ETag yeniden deneme, protokol dönüşümleri, SSE ve upstream hatalarını kapsar. Canlıya alırken giriş → anahtar oluşturma → gerçek model çağrısı → iptal akışı ayrıca doğrulanmalıdır.
