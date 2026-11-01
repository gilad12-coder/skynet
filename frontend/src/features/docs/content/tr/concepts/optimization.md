Skynet, Optimize Anything'dir: herhangi bir yapıtı verinize ve metriğinize göre iyileştiren tek bir ürün. Her çalıştırma aynı çalıştırma sözleşmesini ve aynı metrik sözleşmesini kullanır. Hangi motorların bir yapıt üzerinde çalışabileceğine yapıt türü karar verir.

## Ortak sözleşme

Her çalıştırmanın iki dosyası vardır. `run.py` yapıtı tek bir vaka üzerinde çalıştırır. `metric.py` çıktıyı puanlar.

```python tab="run.py"
from skynet import llm


def run(artifact, input):
    return llm(artifact, input=input)
```

```python tab="metric.py"
def score(input, output, expected=None):
    ok = output == expected
    return (1.0 if ok else 0.0), {"feedback": "Match." if ok else "No match."}
```

- `artifact`, optimize edicinin önerdiği mevcut sürümdür.
- `input`, bir vakanın girdi alanlarını tutan bir dict'tir.
- `expected`, vakanın beklenen değeridir; vakanın beklenen değeri yoksa `None` olur.
- `score` bir çift döndürür: bir sayı ve `"feedback"` dizesi içeren bir dict.

`skynet` yardımcı modülü `llm`, `Image` ve `log` sağlar. Çalıştırma kodundan yapılan bir `llm` çağrısı görev modeline gider. Metrikten yapılan bir `llm` çağrısı metrik modeline gider.

> [!NOTE]
> Çalıştırma kodu sandbox içinde kendi sürecinde çalışır. Metriğin kaynak kodunu, beklenen değeri veya metrik anahtarını göremez.

Metrik sözleşmesinin tamamı için [Metrikler ve puanlayıcılar](/docs/concepts/scorers) sayfasını okuyun.

## Yapıt türleri ve motorlar

| Yapıt türü    | Motorlar                                                                     |
| ------------- | ---------------------------------------------------------------------------- |
| İstem         | Auto, GEPA, Best-of-N, AutoResearch, Meta-Harness, AutoSaddler, ShinkaEvolve |
| Kod           | İstem ile aynı                                                               |
| Metin         | İstem ile aynı                                                               |
| DSPy programı | Auto, DSPy GEPA, DSPy MIPROv2, DSPy BootstrapFewShot                         |

Motorlar iki aileye ayrılır:

- **Yerel motorlar** yapıta kara kutu olarak davranır. İstem, Kod ve Metin yapıtları üzerinde çalışırlar.
- **DSPy optimize edicileri** bir DSPy programının içinde çalışır. Yalnızca DSPy programı yapıtları üzerinde çalışırlar.

DSPy MIPROv2 ve DSPy BootstrapFewShot çiftlere (beklenen çıktıları olan vakalara) ihtiyaç duyar. Tek bir girdiyle bir DSPy programı yalnızca Auto ve DSPy GEPA'yı kullanabilir.

## İstem, Kod ve Metin yapıtları

Yerel motorlar yapıta kara kutu olarak davranır. Bir motor yeni bir sürüm önerir, vakalar üzerinde `run(artifact, input)` çalıştırır ve puanı ve geri bildirimi okur.

Altı yerel motor farklı arama yöntemleri kullanır:

- **GEPA**, sürümleri yansıtma yoluyla evrimleştirir ve bir Pareto cephesi tutar.
- **Best-of-N**, yansıtma modelinden bağımsız öneriler ister ve en iyisini saklar.
- **AutoResearch**, **Meta-Harness**, **AutoSaddler** ve **ShinkaEvolve**, sürüm önermek için bir kodlama ajanı kullanır.

Her motor ve ayarları için [Motorlar](/docs/concepts/engines) sayfasını okuyun.

## DSPy programı yapıtları

DSPy programı bir yapıt türüdür. `run.py` dosyanız modül düzeyinde bir `dspy.Module` oluşturur ve onu `run` içinde çağırır. Dosyada birden fazla modül varsa optimize edilecek olanı `program` olarak adlandırın.

Bir DSPy optimize edicisi çalıştığında şunlar olur:

1. Skynet modülünüzü bulur ve `run` fonksiyonunuzu onun etrafına sarar. Her vaka sizin kendi `run` fonksiyonunuzdan geçer.
2. DSPy optimize edicisi programı eğitim vakaları üzerinde derler.
3. Seçimi doğrulama vakaları üzerinde yapar.
4. Kazanan, her tahmin edicinin talimat metni ile modülün derlenmiş durumunun tamamıdır. Durum, az örnekli (few-shot) demoları da içerir.

Nihai puanlar, Skynet'in kaydettiği programın aynısını ölçer.

| Optimize edici        | Geri bildirim metnini okur |
| --------------------- | -------------------------- |
| DSPy GEPA             | Evet                       |
| DSPy MIPROv2          | Hayır, yalnızca puan       |
| DSPy BootstrapFewShot | Hayır, yalnızca puan       |

DSPy BootstrapFewShot bir yansıtma modeli kullanmaz.

> [!TIP]
> DSPy yansıtma modeli yalnızca metriğinizin döndürdüğü geri bildirim metnini görür. Metriğin kaynak kodunu hiçbir zaman görmez.

## Auto

**Auto**, sihirbazdaki varsayılan seçimdir.

- Bir İstem, Kod veya Metin yapıtında Auto beş yerel motorla keşif yapar, ardından en iyi sürümden GEPA ile devam eder.
- Bir DSPy programında Auto, DSPy GEPA'yı çalıştırır.

Auto'nun her iki biçimi de metriğinizden gelen geri bildirim metnini okur.

## Hangi motoru seçmeli

| Durumunuz                                                     | Kullanın                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Bir modelin çalıştırdığı bir isteminiz var                    | Bir İstem yapıtı. Auto ile başlayın.                                     |
| Daha hızlı, daha ucuz veya daha doğru hâle getirilecek kodunuz var | Bir Kod yapıtı. Auto ile başlayın.                                  |
| Bir belgeniz veya bir yapılandırmanız var                     | Bir Metin yapıtı. Auto ile başlayın.                                     |
| Bir DSPy programınız var                                      | Bir DSPy programı yapıtı. Auto ile başlayın.                             |
| Verinizden seçilmiş az örnekli demolar istiyorsunuz           | DSPy BootstrapFewShot veya DSPy MIPROv2 ile bir DSPy programı yapıtı      |

> [!WARNING]
> GEPA, DSPy GEPA ve Auto geri bildirim metninden öğrenir. Geri bildiriminiz her zaman aynı dizeyse bu optimize edicilerin çalışacağı bilgi azalır.

## İlgili sayfalar

- [Motorlar](/docs/concepts/engines)
- [Veri kümeleri ve bölmeler](/docs/concepts/datasets)
- [Metrikler ve puanlayıcılar](/docs/concepts/scorers)
- [Çalıştırma gönderme](/docs/guides/submit)
