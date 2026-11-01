Etiketleyici, bir veri kümesinin satırlarına etiket ekler. Her satırı kendiniz etiketleyebilir veya bir yapay zekâ modelinin satırları etiketlemesine izin verip onun işini inceleyebilirsiniz. Sonuç, bir çalıştırmada kullanabileceğiniz etiketlenmiş bir veri kümesidir.

## Oturum başlatın

Etiketleyiciyi şu yollardan biriyle açın:

- Etiketleyiciyi panodan açın.
- **Veri kümeleri** içinde bir veri kümesi seçin ve **Bu veri kümesini etiketle** düğmesine tıklayın.
- Veri kümesi düzenleyicisinde **Yapay zekâ ile etiketle** düğmesine tıklayın.

### Veriyi seçin

Kurulum, etiketlenecek veriyi sorar:

- **Kitaplığınızdan seçin**, yüklediğiniz bir veri kümesini kullanır. Yeni bir dosya yüklemek için önce [Veri kümeleri](/docs/guides/datasets) sayfasını kullanın.
- **Sentetik veri kümesi oluştur**, sizin için satırlar oluşturur. Bu seçenek asistanı gerektirir.

### Görev türünü seçin

| Görev türü                     | Her satıra ne verirsiniz                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| **Evet / Hayır sorusu**        | Evet veya hayır yanıtı.                                                                     |
| **Kategorilerden seçim**       | Tanımladığınız bir listeden bir veya daha fazla kategori. En az iki kategori ekleyin.       |
| **Yazılı yanıtlar**            | Serbest metin yanıtı.                                                                       |

### Mod seçin

Kurulum "Nasıl etiketlemek istersiniz?" diye sorar. Üç mod vardır:

| Mod           | Ne olur                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Manuel**    | Her satırı kendiniz etiketlersiniz. Yapay zekâ kullanılmaz.                                                                   |
| **Yardımcı pilot** (Co-pilot) | Kısa bir görüşmeden sonra yapay zekâ ilk grubu etiketler. İnceleme turlarında her etiketi korur veya düzeltirsiniz.          |
| **Otomatik pilot** (Autopilot) | Kısa bir görüşmeden sonra yapay zekâ tüm satırları etiketler ve emin olmadığı satırları işaretler.                           |

Kurulum bir modu **Önerilen** olarak işaretler.

Kurulumda bir **Etiketleme modeli** seçimi de vardır. Varsayılan model çoğu veri kümesine uyar.

> [!NOTE]
> Mac uygulamasında yapay zekâ ile etiketleme kendi sağlayıcı anahtarınızı gerektirir. **Kendi anahtarınız** altında bir model seçin. Bkz. [Mac uygulaması](/docs/guides/mac-app).

## Veri kümesi görüşmesi

Yardımcı pilot ve Otomatik pilot bir **Veri kümesi görüşmesi** ile başlar. Yapay zekâ verileriniz ve etiketleriniz hakkında sorular sorar. **Görüşmeyi atla** düğmesine tıklayabilirsiniz.

Görüşme bir **Etiketleme kılavuzu** oluşturur. Kılavuz, yapay zekânın izlediği kuralları içerir. Kendi kuralınızı eklemek için **Kural ekle** seçeneğini kullanın.

Sonunda yapay zekâ **İşte plan** ekranını gösterir. Ardından işi başlatırsınız:

- Yardımcı pilot modunda **İncelemem için ilk {rows} satırı etiketle** düğmesine tıklayın.
- Otomatik pilot modunda **{rows} satırın tümünü etiketle** düğmesine tıklayın.

## Yardımcı pilot inceleme turları

Yardımcı pilot modunda yapay zekâ önce bir kalibrasyon grubunu etiketler. Grup boyutu görev türüne bağlıdır:

| Görev türü             | İlk grup                                                  |
| ---------------------- | --------------------------------------------------------- |
| Evet / Hayır sorusu    | 24 satır                                                  |
| Kategorilerden seçim   | Her kategori için 6 satır, en az 30 ve en fazla 60        |
| Yazılı yanıtlar        | 30 satır                                                  |

Veri kümesinde daha az satır varsa yapay zekâ hepsini etiketler.

### Her etiketi inceleyin

Her satır için yan panel yapay zekânın etiketini gösterir:

1. Satırı ve etiketi okuyun.
2. Etiketi korumak için **Onayla (Enter)** düğmesine tıklayın veya Enter tuşuna basın.
3. Etiketi değiştirmek için onu düzeltin. Panel "Düzeltildi — yapay zeka bundan öğrenecek" mesajını gösterir.
4. Bitirdiğinizde **Bu turu bitir** düğmesine tıklayın.

Panel hedefi gösterir: "%{gate} oranında aynı fikirde olduğumuzda, gerisini kendim etiketlerim."

### Uyum eşiği

Her turdan sonra Skynet, yapay zekâyla ne sıklıkla aynı fikirde olduğunuzu ölçer. Eşik, Evet / Hayır ve kategori görevleri için %92'dir. Yazılı yanıtlar için %85'tir.

Tur özeti "Yapay zekâyla %{agreement} oranında aynı fikirdeydiniz" mesajını gösterir. Ardından seçim yaparsınız:

- **Bir inceleme turu daha**, size incelemeniz için başka bir grup verir.
- **Kalan {rows} satırı etiketle**, geri kalanı yapay zekânın etiketlemesine izin verir.

## Otomatik pilot ve otomatik etiketleme

Yapay zekâ kalan satırları etiketlerken iş sunucuda çalışır. Sayfadan güvenle ayrılıp geri dönebilirsiniz.

- **Etiketlemeye devam et**, durmuş bir işi sürdürür.
- **İptal et — etiketlenenler kalsın**, işi durdurur ve var olan etiketleri korur.

### Emin olunmayan satırları inceleyin

Yapay zekâ her otomatik etikete bir güven değeri verir. Güven 0,75'in altındaysa Skynet satırı işaretler. İş bittikten sonra bu satırları kontrol etmek için **Yapay zekanın emin olmadığı {count} satırı inceleyin** düğmesine tıklayın.

> [!TIP]
> Veriyi bir çalıştırmada kullanmadan önce işaretli satırları inceleyin. Yanlış etiketler optimizasyonun kalitesini düşürür.

## Manuel mod

Manuel modda her satırı kendiniz etiketlersiniz. Aşağıdaki klavye kısayolları hızlı çalışmanıza yardım eder.

### Klavye kısayolları

| Tuş              | Eylem                                                        |
| ---------------- | ------------------------------------------------------------ |
| Ctrl+H veya Cmd+H | Kısayolları gösterir.                                       |
| Y / N            | Evet / Hayır satırında evet veya hayır yanıtı verir.         |
| 1 ile 9 arası    | Kategori satırında o kategoriyi seçer veya seçimini kaldırır. |
| U                | Sonraki etiketlenmemiş satıra gider.                         |
| Home             | İlk satıra gider.                                            |
| E                | CSV olarak dışa aktarır.                                     |

## Sonuçlar

Sonuçlar her etiketin nereden geldiğini gösterir:

| Sayı                                     | Anlamı                                                   |
| ---------------------------------------- | -------------------------------------------------------- |
| **Sizin tarafınızdan etiketlendi**       | Sizin yazdığınız etiketler.                              |
| **Onayladığınız yapay zeka etiketleri**  | İncelemede koruduğunuz yapay zekâ etiketleri.            |
| **Otomatik olarak etiketlendi**          | İncelenmemiş yapay zekâ etiketleri.                      |
| **Maliyet**                              | Bu oturumdaki yapay zekâ işinin maliyeti.                |

**Kaynak** sütunu her satır için aynı değerleri gösterir: **Siz**, **AI onaylandı** veya **AI**.

## Kaydedin ve dışa aktarın

### Kitaplığa kaydedin

Etiketlenmiş veriyi bir veri kümesi olarak saklamak için **Kütüphaneye kaydet** veya **Veri Kümelerine Taşı** düğmesine tıklayın. Ardından onu bir [çalıştırmada](/docs/guides/submit) kullanabilirsiniz.

### Dosya dışa aktarın

**Etiketleri dışa aktar** düğmesine tıklayın ve bir biçim seçin:

- CSV
- JSON
- Excel (`.xlsx`)
- Parquet
- Feather

Bazı satırların etiketi yoksa Skynet dışa aktarımı onaylamanızı ister.

Dışa aktarım bir etiket sütunu ekler. Sütunun adı görev türüne bağlıdır:

| Görev türü             | Sütun                 |
| ---------------------- | --------------------- |
| Evet / Hayır sorusu    | `binary_label`        |
| Kategorilerden seçim   | `selected_categories` |
| Yazılı yanıtlar        | `extracted_text`      |

Bir `label_source` sütunu her etiketin nereden geldiğini kaydeder.

## Oturumlar

Her etiketleme işi bir oturumdur. Bir oturum şu durumlardan birindedir: **Devam ediyor**, **İncelemede**, **Otomatik etiketleme** veya **Bitti**. Yeni ayarlarla yeniden başlamak için **Yeni oturum başlat** düğmesine tıklayın.

Bir oturumu paylaşım iletişim kutusundan başkalarıyla paylaşabilirsiniz. Paylaşım kuralları için [Paylaşma](/docs/guides/sharing) sayfasına bakın.

## Sonraki adımlar

- Etiketlemeden önce [bir veri kümesi hazırlayın](/docs/guides/datasets).
- Etiketlenmiş veriyle [bir çalıştırma gönderin](/docs/guides/submit).
- Etiketleme oturumlarınızı [aracı paneline](/docs/guides/agent-panel) sorun.
