// Windows supplies only speech output. Recognition belongs to the Vosk worker.
// Commands are JSON on stdin, never interpolated into executable code.
export const windowsVoiceSource = String.raw`
using System;
using System.IO;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Threading;
using System.Speech.Synthesis;
using System.Speech.AudioFormat;
using System.Web.Script.Serialization;
public static class CodebitVoice {
  static JavaScriptSerializer json = new JavaScriptSerializer();
  static ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
  static ConcurrentQueue<Action> events = new ConcurrentQueue<Action>();
  static SpeechSynthesizer synth;
  static int generation;
  static volatile bool eof;
  static void Emit(object value) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
  static string Text(Dictionary<string, object> c, string k) { return c.ContainsKey(k) ? Convert.ToString(c[k]) : ""; }
  static void Halt() {
    generation++;
    if (synth != null) {
      synth.SpeakAsyncCancelAll();
      synth.Dispose();
      synth = null;
    }
  }
  public static void Probe() {
    var voices = new List<object>();
    string reason = "";
    try {
      using (var s = new SpeechSynthesizer())
        foreach (var v in s.GetInstalledVoices())
          if (v.Enabled) voices.Add(new { name = v.VoiceInfo.Name, culture = v.VoiceInfo.Culture.Name });
    } catch (Exception e) { reason = "Voz de saída: " + e.Message; }
    Emit(new { type = "capabilities", recognizers = new object[0], voices = voices, reason = reason });
  }
  static void Speak(Dictionary<string, object> c) {
    Halt();
    synth = new SpeechSynthesizer();
    synth.SelectVoice(Text(c, "voice"));
    string requestId = Text(c, "requestId");
    string output = Text(c, "outputFile");
    if (output.Length > 0) {
      string root = Environment.GetEnvironmentVariable("CODEBIT_VOICE_TEST_OUTPUT_DIR");
      if (String.IsNullOrEmpty(root) || !Path.GetFullPath(output).StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        throw new Exception("Saída de teste fora do diretório permitido.");
      synth.SetOutputToWaveFile(output, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
    }
    int current = generation;
    synth.SpeakCompleted += delegate(object sender, SpeakCompletedEventArgs e) {
      events.Enqueue(delegate {
        if (current != generation) return;
        if (output.Length > 0) synth.SetOutputToNull();
        if (e.Error != null) Emit(new { type = "error", message = e.Error.Message });
        else Emit(new { type = "spoken", requestId = requestId });
      });
    };
    synth.SpeakAsync(Text(c, "text"));
  }
  public static void Run() {
    Console.InputEncoding = System.Text.Encoding.UTF8;
    Console.OutputEncoding = new System.Text.UTF8Encoding(false);
    var reader = new Thread(delegate() {
      string line;
      while ((line = Console.ReadLine()) != null) inbox.Enqueue(line);
      eof = true;
    });
    reader.IsBackground = true;
    reader.Start();
    try {
      while (!eof) {
        string line;
        while (inbox.TryDequeue(out line)) {
          var c = json.Deserialize<Dictionary<string, object>>(line);
          string command = Text(c, "command");
          if (command == "probe") Probe();
          else if (command == "speak") Speak(c);
          else if (command == "pause") { Halt(); Emit(new { type = "paused", requestId = Text(c,"requestId") }); }
          else if (command == "stop") return;
          else throw new Exception("Comando de saída de voz desconhecido.");
        }
        Action action;
        while (events.TryDequeue(out action)) action();
        Thread.Sleep(20);
      }
    } catch (Exception e) { Emit(new { type = "error", message = e.Message }); }
    finally { Halt(); }
  }
}
`;
