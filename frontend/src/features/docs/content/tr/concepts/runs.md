Bir çalıştırma, tek bir optimizasyondur. Bir durumu, bir harcama limiti ve bir dizi kayıtlı sürümü vardır. Bu sayfa çalıştırma durumlarını, bir çalıştırmada yapabileceğiniz eylemleri ve bir çalıştırmanın durma nedenlerini açıklar.

## Çalıştırma durumları

Her çalıştırma şu durumlardan birindedir:

| Durum        | Anlamı                                                                      |
| ------------ | --------------------------------------------------------------------------- |
| `pending`    | Çalıştırma kuyrukta.                                                        |
| `validating` | Skynet, optimizasyon başlamadan önce kurulumu kontrol ediyor.               |
| `running`    | Optimize edici yeni sürümler öneriyor ve puanlıyor.                         |
| `success`    | Çalıştırma bitti. En iyi sürüm kaydedildi.                                  |
| `failed`     | Bir hata çalıştırmayı durdurdu.                                             |
| `cancelled`  | Bir kişi çalıştırmayı iptal etti.                                           |
| `paused`     | Çalıştırma bir kontrol noktasında durdu. Devam ettirebilirsiniz.            |
| `stopped`    | Çalıştırma bütçesinde durdu. Bulduğu en iyi sürümü korur.                   |

`success`, `failed`, `cancelled`, `stopped` ve `paused` son durumlardır. Optimize edici son durumdaki bir çalıştırma üzerinde çalışmaz. `paused`, devam ettirilmek için var olan tek son durumdur.

## Eylemler

Çalıştırma sayfası, geçerli duruma ve rolünüze uyan eylemleri gösterir. API'de de aynı eylemler vardır.

| Eylem              | Ne zaman kullanabilirsiniz                                                                                              | Ne yapar                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Duraklat**       | Çalıştırma sürüyor ve kayıtlı bir kontrol noktası var.                                                                  | Çalıştırmayı kontrol noktasında durdurur. Durum `paused` olarak değişir.            |
| **İptal et**       | Çalıştırma `pending`, `validating` veya `running` durumunda.                                                            | Çalıştırmayı durdurur. İptal işlemini geri alamazsınız.                             |
| **Devam ettir**    | Çalıştırma `failed`, `cancelled`, `paused` veya bütçesinde `stopped` durumunda ve kayıtlı bir kontrol noktası var.      | Aynı çalıştırmayı son kontrol noktasından sürdürür. Çalıştırma kimliğini korur.     |
| **Klonla**         | Çalıştırmayı görebildiğiniz her zaman.                                                                                  | Gönderme sihirbazını yapılandırmanın bir kopyasıyla açar.                           |
| **Sil**            | Çalıştırma son durumda. Yalnızca sahip.                                                                                 | Çalıştırmayı ve tüm verilerini kalıcı olarak siler.                                 |

API'de `failed` veya `cancelled` durumundaki bir çalıştırma için iki eylem daha vardır:

- **Yeniden dene**, aynı yapılandırmayla yeni bir çalıştırma başlatır. Yeni çalıştırma yeni bir kimlik alır.
- **Baştan başlat**, aynı çalıştırmayı en baştan yeniden başlatır. Çalıştırma kimliğini korur.

> [!NOTE]
> Yeniden deneme, baştan başlatma ve API ile klonlama, kendi harcama limiti olan bir çalıştırmayı reddeder. Yeni bir çalıştırma başlatmadan önce yapılandırmayı gönderme sihirbazında açın ve yeni bir bütçe belirleyin. Çalıştırma sayfasındaki **Klonla** düğmesi bunu sizin için yapar.

API ile klonlama tek istekte 1 ila 5 kopya oluşturabilir. Her kopya çalıştırma limitlerinizden düşer. Bkz. [Limitler](/docs/limits).

### Kim hangi eylemi yapabilir

Çalıştırmadaki rolünüz gördüğünüz eylemleri belirler:

- **Sahip** tüm eylemleri yapabilir, paylaşımı yönetebilir ve çalıştırmayı silebilir.
- **Düzenleyici** çalıştırmayı duraklatabilir, iptal edebilir, devam ettirebilir, yeniden deneyebilir ve harcama limitini yükseltebilir.
- **Görüntüleyici** çalıştırmayı açabilir ve klonlayabilir.

Roller hakkında daha fazla bilgi için [Paylaşma ve yayımlama](/docs/guides/sharing) sayfasını okuyun.

## Bir çalıştırma nasıl durur

Bir çalıştırma dört nedenden biriyle durur.

### Tamamlanma

Optimize edici işini bitirir. Durum `success` olarak değişir. Skynet en iyi sürümü kaydeder ve son testi çalıştırır. [Sonuçları okuyun](/docs/guides/results) sayfasına bakın.

### Bütçe

Bir çalıştırmanın başlamadan önce maliyet tahmini yoktur. Harcama limiti, kullanabileceği bütçedir. Skynet, çalıştırma ilerledikçe her puanlayıcı çalıştırmasının gerçek maliyetini ölçer:

1. Skynet, kesinleşmiş 10 puanlayıcı çalıştırmasını bekler. Bundan önce tek bir çağrının maliyeti kullanılamayacak kadar dalgalıdır.
2. Skynet bir sonraki yinelemeyi fiyatlamak için şimdiye kadarki ortalama maliyeti kullanır. Fiyatı 1,5 ile çarpar, çünkü sonraki yinelemeler genellikle daha pahalıdır.
3. Kalan bütçe bir sonraki yinelemeyi karşılayamadığında Skynet yeni iş kabul etmeyi durdurur. Optimize edici bir sonraki ücretli çağrısında durur.

Çalıştırma bu durumda `stopped` durumunu ve `budget_reached` durma nedenini alır. Çalıştırma sayfası bir **Bütçe sınırına ulaşıldı** bildirimi gösterir. Bildirim, Skynet'in hangi sürümü kaydettiğini söyler:

- Değerlendirilmiş en iyi sürümünüz.
- Daha iyi bir sürüm bulunmadıysa değerlendirilmiş başlangıç sürümünüz.
- Bütçe herhangi bir aday değerlendirmeyi bitirmeden tükendiyse hiçbir sürüm. Girdileriniz ve günlükleriniz kayıtlı kalır.

Devam etmek için bildirimdeki **Limiti yükselt ve devam et** seçeneğini kullanın. Skynet çalıştırmayı son kontrol noktasından sürdürür.

> [!TIP]
> **Limit yok** seçili bir çalıştırma, bitene kadar hesap bakiyenizden harcar. Bakiye tükenirse çalıştırma durur ve elde ettiklerini korur. Bildirim bu durumda **Hesap bakiyesi tükendi** der. Bakiye ekleyin, ardından çalıştırmayı devam ettirin.

Bazı eski çalıştırmalar `budget_projected` durma nedeniyle duraklatıldı. Bunları da aynı şekilde devam ettirebilirsiniz.

### Hata

Bir hata çalıştırmayı durdurur. Durum `failed` olarak değişir. **Günlükler** sekmesi ne olduğunu gösterir. Çalıştırmanın kayıtlı bir kontrol noktası varsa devam ettirebilirsiniz. Yeniden de deneyebilirsiniz.

Bir çalışan (worker) işinizi yürütürken durursa Skynet işi kurtarır ve yeniden dener. 3 denemeden sonra Skynet işi başarısız olarak işaretler. Bir hata veya iptalden sonra yapılan devam ettirme de bir deneme sayılır. Bir duraklatma veya bütçe durmasından sonra yapılan devam ettirme sayılmaz.

### İptal

Çalıştırmayı siz iptal edersiniz. Durum `cancelled` olarak değişir. İptal işlemini geri alamazsınız. Daha sonra çalıştırmayı kayıtlı bir kontrol noktasından devam ettirebilir veya yeniden deneyebilirsiniz.

## İlgili sayfalar

- [Bütçeler ve faturalandırma](/docs/concepts/billing)
- [Sihirbazla çalıştırma başlatın](/docs/guides/submit)
- [Limitler](/docs/limits)
