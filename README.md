# nano-claude-code-js

Bản JavaScript **rút gọn** của vòng lặp agent trong project Python `nano-claude-code`, viết để đọc và học.
Chạy trên Node.js 18.3 trở lên, **không cần `npm install`** (gọi API bằng `fetch` có sẵn của Node).

Muốn hiểu agent hoạt động thế nào: đọc mục [Cơ chế hoạt động](#cơ-chế-hoạt-động-của-agent-mức-logic), rồi chạy `npm run demo`
để xem tận mắt. Muốn biết một lần gọi API trông ra sao (request, response, lỗi): xem mục
[API gọi LLM](#api-gọi-llm-ví-dụ-với-anthropic).

## Chạy thử ngay (không cần API key)

```bash
npm run demo          # chạy một lần: đọc task.txt → grep A/B/C.js → ghi result.md
npm run demo:agent    # giao việc cho SUB-AGENT, xem payload riêng của nó
npm run chat:mock     # chế độ tương tác với LLM giả (gõ nhiều prompt, thử /history)
```

LLM giả (xem `src/mock.js`) chỉ trả lời theo kịch bản cố định, để bạn nhìn thấy cơ chế. Nó in ra từng lượt:
payload gửi lên, response nhận về, tool được chạy và kết quả. Thêm `--full` để xem đầy đủ system prompt và tools.
Mỗi lần chạy `demo` sẽ tạo lại file `demo/result.md`.

Trong `chat:mock`, thử gõ lần lượt: `Dùng sub-agent đọc task.txt` → `/history` → `Đọc file task.txt rồi grep ...` → `/history`.
Bạn sẽ thấy danh sách tin nhắn dài ra qua từng prompt, và lượt đầu của prompt thứ hai bắt đầu với số tin nhắn đã có sẵn.

Muốn thấy **tự tóm tắt**: chạy `node src/cli.js --mock --yes --cwd demo -i --context-window 500` rồi gõ ba prompt liên tiếp
(ví dụ `Đọc file task.txt rồi grep ...`, `Dùng sub-agent đọc task.txt`, `Đọc lại task.txt`), sau đó gõ `/history`. Ngưỡng bị hạ thấp nên
trước prompt thứ ba, lịch sử sẽ được thu gọn (LLM giả trả về một bản tóm tắt giả). Gõ `/compact` để tóm tắt ngay không cần chờ ngưỡng.

## Hai chế độ chạy

```bash
node src/cli.js "<prompt>"       # MỘT LẦN: chạy xong thoát (tương ứng chế độ -p của bản Python)
node src/cli.js                  # TƯƠNG TÁC: gõ liên tục, lịch sử được giữ (tương ứng REPL của bản Python)
node src/cli.js -i "<prompt>"    # tương tác, bắt đầu bằng prompt này
```

(Riêng `--mock` mà không có prompt thì chạy luôn kịch bản mẫu một lần, để `npm run demo` hoạt động. Thêm `-i` nếu muốn tương tác.)

Lệnh trong chế độ tương tác: `/help`, `/clear` (`/new`, `/reset`), `/compact`, `/history`, `/context`, `/cost`, `/exit`.
`Ctrl+C` khi agent đang chạy sẽ huỷ lượt đó; khi đang chờ gõ thì nhấn hai lần trong vòng 1 giây để thoát (hoặc `Ctrl+D`).

Các tuỳ chọn chính (xem đầy đủ bằng `node src/cli.js --help`):

| Tuỳ chọn | Ý nghĩa |
|---|---|
| `--mock` | Dùng LLM giả, không cần API key |
| `--provider anthropic\|openai`, `--model <tên>` | Chọn provider và model (mặc định tự chọn theo biến môi trường) |
| `--cwd <thư mục>` | Thư mục làm việc của agent (mặc định: thư mục hiện tại) |
| `--max-turns <n>` | Số lượt tối đa cho mỗi prompt (mặc định 50) |
| `--context-window <n>` | Cửa sổ ngữ cảnh của model, tính bằng token (mặc định 200000). Vượt 75% thì tự tóm tắt (chế độ tương tác) |
| `--show-payload`, `--full` | In nội dung gửi lên API mỗi lượt (`--full`: không rút gọn) |
| `--yes` | Tự đồng ý mọi thao tác Write/Edit/Bash, không hỏi |

## Chạy với LLM thật

Đặt các biến môi trường sau, trong shell hoặc trong file `.env` ở thư mục bạn chạy lệnh
(**file `.env` chỉ được tự đọc trên Node 20.6 trở lên**; Node cũ hơn thì dùng `export`/`set`):

```bash
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_MODEL=...            (tuỳ chọn, mặc định claude-sonnet-5-5)
# ANTHROPIC_BASE_URL=...         (tuỳ chọn, dùng khi đi qua proxy)
# DISABLE_PROMPT_CACHING=1       (tuỳ chọn, tắt prompt caching nếu proxy không hỗ trợ)

# hoặc OpenAI / dịch vụ tương thích
OPENAI_COMPAT_API_KEY=...
OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1
OPENAI_COMPAT_MODEL=<tên model>
```

```bash
node src/cli.js --cwd demo --show-payload "Đọc task.txt rồi làm theo yêu cầu, ghi kết quả vào result.md"
```

Mặc định chương trình **hỏi `y/N` trước khi chạy Write, Edit, Bash** (kể cả khi sub-agent gọi). Thêm `--yes` để bỏ qua việc hỏi.
Chỉ dùng `--yes` trên thư mục bạn không ngại bị sửa. Nếu stdin không phải terminal (ví dụ chạy qua pipe) mà không có `--yes`,
mọi thao tác cần quyền bị từ chối.

## Cơ chế hoạt động của agent (mức logic)

### Ba điều cần nhớ

1. **Model không nhớ gì.** Mỗi lần gọi, model chỉ biết đúng những gì được gửi trong lần gọi đó, không biết gì về lần trước.
2. **Model không tự làm gì trên máy bạn.** Nó chỉ *đề nghị* ("hãy đọc file X", "hãy chạy lệnh Y"). Chương trình mới là bên thực sự
   đọc file, chạy lệnh, rồi báo kết quả lại cho model.
3. **"Trí nhớ" chỉ là một danh sách tin nhắn mà chương trình giữ lại.** Mỗi lần gọi model, chương trình gửi lại **toàn bộ** danh sách
   đó từ đầu. Tin mới luôn được **thêm vào cuối**; tin cũ không bị sửa hay xoá. Model đọc cả danh sách như đọc một đoạn hội thoại dài
   rồi viết tiếp phần của nó.

(Trong tài liệu của API, "đề nghị gọi công cụ" có tên là `tool_use` và "kết quả công cụ" là `tool_result`. Chạy với `--show-payload` để
thấy chúng.)

### Mỗi lần gọi model, chương trình gửi gì?

Ba phần tách biệt:

| Phần | Nội dung | Thay đổi thế nào |
|---|---|---|
| **Chỉ dẫn hệ thống** | Vai trò của agent, quy tắc làm việc, thư mục làm việc, ngày, nội dung `CLAUDE.md` nếu có | Dựng lại mỗi khi người dùng gõ một prompt mới; trong cùng một prompt thì giữ nguyên |
| **Danh sách công cụ** | Tên, mô tả, tham số của từng công cụ. Model chỉ biết mình có công cụ gì nhờ danh sách này | Cố định |
| **Lịch sử hội thoại** | Danh sách tin nhắn từ đầu đến giờ | **Dài ra** sau mỗi lượt |

(Với OpenAI, chỉ dẫn hệ thống được đặt làm tin nhắn đầu tiên của lịch sử thay vì một phần riêng; nội dung vẫn như vậy.)

### Lịch sử dài ra như thế nào: một ví dụ

Người dùng gõ: *"Đọc task.txt rồi grep A.js, B.js và ghi kết quả vào result.md"*. Lịch sử tăng dần như sau
(mỗi dòng mới luôn nằm dưới cùng):

```
Gõ prompt xong ─────────────────────────────────────────────────────  gửi lượt 1 (1 tin)
 1  Người dùng   "Đọc task.txt rồi grep A.js, B.js và ghi result.md"

Model trả lời, chương trình đọc file, rồi thêm 2 tin ──────────────────  gửi lượt 2 (3 tin)
 2  Model        "Tôi sẽ đọc task.txt" + đề nghị: Read(task.txt)
 3  Kết quả      nội dung task.txt                    ← chương trình đọc file thật rồi chèn vào cuối

Model đề nghị grep hai file cùng lúc, chương trình chạy cả hai ──────  gửi lượt 3 (5 tin)
 4  Model        "Tôi grep hai file" + đề nghị: Grep(A.js), Grep(B.js)
 5  Kết quả      kết quả Grep A.js và kết quả Grep B.js

Model đề nghị ghi file, chương trình ghi ─────────────────────────────  gửi lượt 4 (7 tin)
 6  Model        "Ghi kết quả" + đề nghị: Write(result.md, nội dung...)
 7  Kết quả      "Đã ghi result.md"

Lượt 4: model trả lời bằng chữ, KHÔNG đề nghị công cụ nào ──────────────  dừng (lịch sử còn 8 tin)
 8  Model        "Đã ghi kết quả vào result.md. DONE"
```

Vài điều rút ra từ ví dụ:

- **Nội dung file model đọc được nằm ở tin "Kết quả"**, không phải trong câu "Tôi sẽ đọc task.txt". Câu đó chỉ là lời model nói; lúc đó
  chưa ai đọc file. Chương trình đọc file thật rồi mới chèn nội dung vào tin kế tiếp.
- **Mỗi kết quả được ghép với đề nghị tương ứng** bằng một mã định danh, nên khi model đề nghị hai Grep cùng lúc nó biết kết quả nào
  của lệnh nào.
- **Tin "Kết quả" được gắn nhãn là của "người dùng"** theo quy ước của API (hội thoại phải xen kẽ người dùng và model), dù thực tế do
  chương trình gửi.
- **Mỗi lượt gửi lại toàn bộ lịch sử.** Lượt 4 gửi cả 7 tin trước đó chứ không chỉ tin mới nhất.

### Một prompt được xử lý thế nào (vòng lặp trong)

1. Chương trình gửi lên: chỉ dẫn hệ thống + danh sách công cụ + toàn bộ lịch sử.
2. Model trả lời. Câu trả lời có thể gồm chữ, một hay nhiều đề nghị gọi công cụ, hoặc cả hai. Chương trình thêm nguyên văn
   câu trả lời đó vào cuối lịch sử.
3. Chương trình kiểm tra: model có đề nghị công cụ nào không?
   - **Có**: chạy từng công cụ trên máy bạn (hỏi quyền trước nếu là ghi file, sửa file, chạy lệnh), gom kết quả thành một tin mới,
     thêm vào cuối lịch sử, rồi quay lại bước 1.
   - **Không**: coi như model đã xong. Dừng, in câu trả lời.

**Khi nào dừng?**

- Điều kiện chính: model trả lời mà **không đề nghị công cụ nào**.
- Hết số lượt tối đa (mặc định 50): báo lỗi.
- Lỗi API không cứu được (chương trình tự thử lại tối đa 5 lần, chờ lâu dần, khi bị giới hạn tốc độ hoặc server lỗi).
- Người dùng huỷ bằng Ctrl+C.
- Trường hợp *không* dừng: model bị cắt giữa chừng vì hết hạn mức độ dài câu trả lời. Chương trình tự thêm một tin "hãy viết tiếp,
  đừng lặp lại" rồi gọi lại, tối đa 3 lần.

**Lỗi của công cụ không làm dừng.** File không tồn tại, lệnh trả mã lỗi, người dùng từ chối quyền... đều trở thành một "kết quả" có
đánh dấu lỗi và được thêm vào lịch sử như bình thường. Model đọc được và tự đổi cách làm (ví dụ thử đường dẫn khác).

### Prompt tiếp theo: vòng lặp ngoài

- **Chế độ tương tác** giữ **một** danh sách tin nhắn cho cả phiên. Khi người dùng gõ prompt mới, nó được thêm vào cuối danh sách
  (ngay sau câu trả lời cuối của prompt trước), rồi vòng lặp trong chạy lại như trên. Vì lượt đầu của prompt mới gửi lại cả
  danh sách, model thấy toàn bộ những gì đã xảy ra từ đầu phiên. Đó là cách nó "nhớ".
- **Chế độ một lần** chỉ là vòng ngoài chạy đúng một vòng, với danh sách bắt đầu rỗng.
- `/clear` đơn giản là làm trống danh sách đó; `/history` cho xem danh sách đang giữ những gì.

Hệ quả: **danh sách chỉ lớn lên**, nên mỗi lượt càng về sau càng gửi nhiều và tốn hơn. (Prompt caching của Anthropic giúp tính rẻ
hơn phần đầu lặp lại, nhưng không đổi cách hoạt động.) Mục kế tiếp nói về cách chương trình giữ cho danh sách đó không vượt trần.

### Khi hội thoại quá dài: tự tóm tắt

Model có giới hạn độ dài ngữ cảnh (số token tối đa nó đọc được trong một lần gọi), mà lịch sử thì chỉ dài ra. Để không chạm trần,
chương trình tự "dọn" lịch sử:

1. **Ngay trước khi thêm prompt mới**, chương trình xem ngữ cảnh ở lần gọi model gần nhất đã dùng bao nhiêu token. Nếu vượt 75% cửa sổ
   ngữ cảnh (mặc định 200.000 token, chỉnh bằng `--context-window`) thì bắt đầu tóm tắt.
2. Chia lịch sử làm hai phần: **phần cũ** và **vài tin cuối** (khoảng 6 tin).
3. Nhờ model tóm tắt phần cũ thành 2-3 đoạn. Đây là một lần gọi riêng: chỉ gửi đoạn hội thoại cần tóm tắt, không kèm công cụ.
4. Thay toàn bộ phần cũ bằng **một tin duy nhất chứa bản tóm tắt**; vài tin cuối giữ nguyên. Prompt mới được thêm vào cuối như thường lệ.

```
trước:  [1][2][3][4][5][6][7][8][9][10][11][12]
sau:    [bản tóm tắt của 1..6][7][8][9][10][11][12]   ← rồi prompt mới thêm vào cuối
```

Điều cần biết:

- **Chi tiết cũ bị mất**, chỉ còn bản tóm tắt; model có thể không còn nhớ những gì đã bị lược đi.
- **Chỗ cắt không bao giờ tách một đề nghị gọi công cụ khỏi kết quả của nó** (API từ chối lịch sử bị tách). Khi cần, chương trình giữ
  thêm một tin để giữ nguyên cặp.
- **Tóm tắt lần sau luôn đưa bản tóm tắt lần trước vào**, nên thông tin từ đầu phiên không mất dần qua các lần tóm tắt.
- **Lỗi hoặc Ctrl+C khi đang tóm tắt không làm mất gì**: lịch sử chỉ bị thay sau khi tóm tắt thành công. Nếu tóm tắt lỗi, chương trình
  báo và giữ nguyên lịch sử.
- Gõ `/compact` để tóm tắt ngay; `/context` cho biết mức đang dùng và ngưỡng.
- **Chỉ kiểm tra ngay trước mỗi prompt mới ở chế độ tương tác.** Một prompt đơn lẻ chạy rất dài (nhiều chục lượt), hoặc chế độ chạy một
  lần, không được tóm tắt giữa chừng; bản Python cũng vậy.
- **Đặt `--context-window` đúng với model thật.** Model chỉ có cửa sổ 128k mà để mặc định 200k thì việc tóm tắt đến quá muộn.
  Nếu API chưa báo số token (hoặc dùng LLM giả) thì chương trình chỉ ước lượng thô theo độ dài chữ.

### Sub-agent: giao việc cho một "đồng nghiệp"

Với agent chính, `Agent` chỉ là một công cụ như mọi công cụ khác: đưa vào lời giao việc, nhận về một đoạn chữ. Bên trong, chương
trình chạy **một agent khác hoàn toàn**:

- có **sổ ghi chép riêng**: lịch sử riêng, bắt đầu rỗng, chỉ có đúng lời giao việc. Nó không thấy gì từ hội thoại của agent chính.
- có **chỉ dẫn riêng** theo loại (`general-purpose`, `Explore` chỉ đọc, `Plan` lập kế hoạch) và **bộ công cụ bị giới hạn**
  (không có `Agent`, nên không thể sinh thêm sub-agent; `Explore` và `Plan` cũng không có `Write`, `Edit`).
- chạy tối đa 10 lượt, rồi nộp **một bản báo cáo**. Báo cáo đó trở thành "kết quả công cụ" trong lịch sử của agent chính.

Những gì sub-agent đã đọc hay đã chạy trong quá trình làm **không** được đưa vào lịch sử chính, nên không làm phình ngữ cảnh. Đó là
lợi ích chính của sub-agent. Dùng `--show-payload` để thấy payload của sub-agent chỉ có 1 tin nhắn, khác hẳn payload của agent chính.

Giới hạn: sub-agent chạy **lần lượt và chặn** (agent chính đứng chờ; không chạy song song hay chạy nền), và chỉ cách ly về **ngữ cảnh**,
không cách ly môi trường: nó dùng chung thư mục và file với agent chính. Bản Python cũng vậy.

### Khi có sự cố

- **Ctrl+C hoặc lỗi API giữa chừng**: lịch sử được cắt về đúng như trước khi gõ prompt đó. Lý do: nếu để lại một đề nghị gọi công cụ
  chưa có kết quả, API sẽ từ chối mọi lần gọi sau và phiên bị kẹt.
- **Quyền**: ghi file, sửa file, chạy lệnh đều hỏi `y/N` (kể cả khi do sub-agent gọi). Từ chối thì model nhận được kết quả "bị từ
  chối" và có thể đổi hướng.

## API gọi LLM: ví dụ với Anthropic

Phần này nói về lớp thấp nhất: **một lần gọi API trông thế nào**. Toàn bộ agent chỉ là việc gọi đi gọi lại đúng một API này
(code ở `src/providers.js`, hàm `postJson`, `buildBody`, `send`).

### Bản chất: một request HTTP POST

Không có SDK, không có kết nối giữ sẵn. Mỗi lượt là **một request HTTP độc lập**, gửi JSON, nhận JSON:

| | |
|---|---|
| Địa chỉ | `POST https://api.anthropic.com/v1/messages` (đổi gốc bằng `ANTHROPIC_BASE_URL` nếu đi qua proxy) |
| Header | `x-api-key: <khoá của bạn>`, `anthropic-version: 2023-06-01`, `content-type: application/json` |
| Body | JSON có 5 trường chính: `model`, `max_tokens`, `system`, `tools`, `messages` |

Vì mỗi request độc lập nên server không nhớ gì giữa hai lần gọi (đúng "Ba điều cần nhớ" ở trên): muốn model biết chuyện cũ thì
phải gửi lại trong `messages`.

### Gọi tay bằng curl (ví dụ nhỏ nhất)

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-5-5",
    "max_tokens": 1024,
    "messages": [{ "role": "user", "content": "Xin chào" }]
  }'
```

Chỉ `model`, `max_tokens`, `messages` là bắt buộc. `system` và `tools` là tuỳ chọn; agent này luôn dùng cả hai.

### Các trường của body

| Trường | Ý nghĩa |
|---|---|
| `model` | Tên model, ví dụ `claude-sonnet-5-5` |
| `max_tokens` | **Trần độ dài câu trả lời** của lần gọi này (không phải độ dài đầu vào). Model viết quá trần thì bị cắt và `stop_reason` là `max_tokens` |
| `system` | Chỉ dẫn hệ thống: vai trò, quy tắc. Là trường riêng, **không** nằm trong `messages` |
| `tools` | Danh sách công cụ model được phép đề nghị gọi. Mỗi công cụ có `name`, `description`, `input_schema` (JSON Schema của tham số) |
| `messages` | Lịch sử hội thoại: mảng các `{ role, content }`, `role` chỉ là `user` hoặc `assistant`, xen kẽ nhau |

`content` của một tin nhắn là **chuỗi** (cách viết tắt) hoặc **mảng block**. Các loại block dùng trong agent này:

| Block | Do ai tạo | Ý nghĩa |
|---|---|---|
| `{ type: "text", text }` | người dùng hoặc model | chữ thường |
| `{ type: "tool_use", id, name, input }` | **model** (nằm trong tin `assistant`) | "hãy chạy công cụ `name` với tham số `input`"; `id` là mã để ghép kết quả |
| `{ type: "tool_result", tool_use_id, content, is_error }` | **chương trình** (nằm trong tin `user`) | kết quả chạy công cụ có mã `tool_use_id`; `is_error: true` nếu lỗi |

### Request đầy đủ (rút gọn) ở lượt 2 của ví dụ "đọc task.txt"

```json
{
  "model": "claude-sonnet-5-5",
  "max_tokens": 16384,
  "system": [
    { "type": "text", "text": "You are a coding agent... Working directory: ...", "cache_control": { "type": "ephemeral" } }
  ],
  "tools": [
    {
      "name": "Read",
      "description": "Read a file...",
      "input_schema": {
        "type": "object",
        "properties": { "file_path": { "type": "string" } },
        "required": ["file_path"]
      }
    }
  ],
  "messages": [
    { "role": "user", "content": "Đọc task.txt rồi làm theo yêu cầu" },
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "Tôi sẽ đọc task.txt trước." },
        { "type": "tool_use", "id": "toolu_01A", "name": "Read", "input": { "file_path": "task.txt" } }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_01A",
          "content": "Liệt kê những chỗ gọi hàm connect_db.",
          "cache_control": { "type": "ephemeral" }
        }
      ]
    }
  ]
}
```

Đây là cách tin "Kết quả" trong sơ đồ ở trên thực sự được gửi: một tin `role: "user"` chứa block `tool_result`, mã `tool_use_id`
khớp với `id` của `tool_use` ở tin trước. Nội dung file nằm ở trường `content` của block đó.

### Response

```json
{
  "id": "msg_01XYZ",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-5-5",
  "content": [
    { "type": "text", "text": "Tôi sẽ grep hai file." },
    { "type": "tool_use", "id": "toolu_01B", "name": "Grep", "input": { "pattern": "connect_db", "path": "A.js" } },
    { "type": "tool_use", "id": "toolu_01C", "name": "Grep", "input": { "pattern": "connect_db", "path": "B.js" } }
  ],
  "stop_reason": "tool_use",
  "usage": {
    "input_tokens": 120,
    "output_tokens": 85,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 2400
  }
}
```

- **Một response = một tin `assistant`** có `content` là mảng block (chữ và/hoặc nhiều `tool_use`). Chương trình nối nguyên mảng
  `content` này vào lịch sử (`messages.push({ role: 'assistant', content })`).
- **`stop_reason`** cho biết model dừng vì sao:

  | Giá trị | Nghĩa | Chương trình làm gì |
  |---|---|---|
  | `tool_use` | model đề nghị gọi công cụ | chạy công cụ, gửi lại kết quả |
  | `end_turn` | model nói xong | dừng vòng lặp |
  | `max_tokens` | bị cắt vì chạm `max_tokens` | gửi "hãy viết tiếp" (tối đa 3 lần) |

  Code **không** dựa riêng vào `stop_reason` để biết có công cụ hay không: nó lọc các block `type === 'tool_use'` trong `content`
  (`src/agent.js`). `stop_reason` chỉ dùng để nhận ra trường hợp bị cắt.
- **`usage`** là số token. `input_tokens` chỉ đếm phần đầu vào **chưa** nằm trong cache; phần lấy từ cache và phần vừa ghi vào cache
  nằm ở hai trường `cache_*`. Cộng cả ba mới ra kích thước ngữ cảnh thật (dùng để quyết định tự tóm tắt).

### Prompt caching (`cache_control`)

Mỗi lượt đều gửi lại cả lịch sử, nên phần đầu giống hệt lần trước. `cache_control: { type: "ephemeral" }` là lời nhắn cho Anthropic:
"phần nội dung tính đến chỗ này, hãy nhớ lại để lần sau tính rẻ hơn". Chương trình đặt dấu ở cuối `system` và ở block cuối của
tin `user` cuối cùng (hàm `addCacheBreakpoint`). Nó chỉ ảnh hưởng **giá và tốc độ**, không đổi kết quả. Nếu proxy không hỗ trợ,
đặt `DISABLE_PROMPT_CACHING=1`.

### Khi gọi lỗi

API trả HTTP status khác 200. Chương trình (hàm `postJson`) xử lý:

| Status | Nghĩa | Xử lý |
|---|---|---|
| `429`, `500`, `502`, `503`, `504`, `529` | bị giới hạn tốc độ, server lỗi hoặc quá tải | chờ lâu dần (có thể theo header `retry-after`) rồi thử lại, tối đa 5 lần |
| lỗi mạng | mất kết nối | thử lại như trên |
| `400`, `401`, `403`, `404`... | body sai, khoá sai, không có quyền | **không** thử lại, báo lỗi ngay kèm nội dung server trả về |

Lỗi `400` hay gặp khi viết agent: lịch sử không hợp lệ (ví dụ có `tool_use` mà thiếu `tool_result` tương ứng), nên chương trình
cắt lịch sử về trạng thái cũ khi hỏng giữa chừng.

### Còn OpenAI thì khác gì?

Cùng ý tưởng, khác hình thức. Lịch sử trong bộ nhớ vẫn theo kiểu Anthropic; `openaiProvider` chỉ **dịch** ngay trước khi gửi và dịch ngược khi nhận:

| | Anthropic | OpenAI (Chat Completions) |
|---|---|---|
| Địa chỉ | `/v1/messages` | `/chat/completions` |
| Xác thực | header `x-api-key` | header `authorization: Bearer ...` |
| System prompt | trường `system` riêng | tin nhắn đầu tiên của `messages`, `role: "system"` |
| Khai báo công cụ | `{ name, description, input_schema }` | `{ type: "function", function: { name, description, parameters } }` |
| Model đề nghị gọi công cụ | block `tool_use` trong `content`, tham số là **object** | trường `tool_calls` của tin `assistant`, tham số là **chuỗi JSON** |
| Trả kết quả công cụ | block `tool_result` trong **một** tin `user` | **mỗi** kết quả một tin riêng `role: "tool"` |
| Dấu hiệu dừng | `stop_reason`: `tool_use` / `end_turn` / `max_tokens` | `finish_reason`: `tool_calls` / `stop` / `length` |
| Nơi lấy câu trả lời | `content` (mảng block) | `choices[0].message` |

Hàm `send` của mỗi provider đổi response về **một dạng chung** `{ stopReason, content: [block...], usage }`, nên `agent.js` không biết
mình đang nói chuyện với bên nào.

## Bản đồ file (so với bản Python)

Nên đọc theo thứ tự: `agent.js` → `repl.js` → `providers.js` → `tools.js`.

| File JS | Làm gì | Tương ứng bên Python |
|---|---|---|
| `src/agent.js` | **Vòng lặp trong** + chạy sub-agent | `agent.py`, `tool_agent` trong `tools_impl.py` |
| `src/repl.js` | **Vòng lặp ngoài** (người dùng gõ liên tục), lệnh `/...`, Ctrl+C | `run_repl` trong `cli.py` |
| `src/compact.js` | **Tự tóm tắt** khi hội thoại quá dài | `compact_messages`, `_needs_compaction` trong `agent.py` |
| `src/profiles.js` | 3 profile sub-agent: general-purpose, Explore, Plan | `agents.py` |
| `src/providers.js` | Dựng payload, gọi API, dịch Anthropic ⇄ OpenAI, thử lại khi lỗi | `agent.py`, `openai_compat.py` |
| `src/tools.js` | Định nghĩa công cụ + hàm chạy công cụ thật | `tools_impl.py` |
| `src/prompt.js` | Dựng chỉ dẫn hệ thống (của agent chính và của sub-agent) | `prompts.py` |
| `src/cli.js` | Đọc tham số, chọn provider, chọn chế độ | `cli.py` |
| `src/mock.js` | LLM giả để chạy thử | (không có bên Python) |
| `demo/` | Dữ liệu mẫu cho `npm run demo` | (không có bên Python) |

## Khác biệt so với bản Python

**Không có:** streaming, extended thinking, lưu và nạp session, skill, profile sub-agent tự viết
trong `.claude/agents/*.md`, tool `TodoWrite`/`WebFetch`/`WebSearch`/`NotebookEdit`, đầu ra `stream-json`, OpenRouter, các lệnh
`/save /load /model /thinking ...`.

**Đơn giản hơn:**
- Chỉ 6 công cụ thường (Read, Write, Edit, Bash, Glob, Grep) cộng `Agent`.
- `Bash` không nhớ thư mục giữa các lần gọi và không có sandbox.
- `Grep` tự viết bằng JavaScript (bản Python dùng ripgrep nếu có).
- `CLAUDE.md`: chỉ đọc đúng một file ngay trong thư mục làm việc. Bản Python đọc cả hệ thống phân tầng (`~/.claude`, các thư mục từ
  gốc xuống thư mục làm việc, `CLAUDE.local.md`, `@include`).

**Cố ý khác bản Python (an toàn hơn):**
- Sub-agent **vẫn bị hỏi quyền** khi gọi Write/Edit/Bash (bản Python gọi thẳng không hỏi).
- Sub-agent dùng **cùng provider** với agent chính (theo code bản Python, sub-agent luôn tạo client Anthropic).
- Lỗi API giữa chừng cũng cắt lịch sử về trước prompt đó (bản Python chỉ làm vậy khi Ctrl+C).
- Sub-agent bị dừng vì hết lượt thì báo cáo có thêm dòng `[sub-agent stopped early: ...]`.

**Tự tóm tắt: giống ý tưởng của bản Python (giữ 6 tin cuối, ngưỡng 75% của 200.000, tóm tắt phần cũ rồi thay thế), nhưng khác ở:**
- **Chỗ cắt**: bản JS không tách cặp "đề nghị gọi công cụ – kết quả". Bản Python cắt cứng đúng 6 tin cuối, có thể để một kết quả
  công cụ đứng đầu mà đề nghị của nó đã bị tóm tắt đi; cách cắt đó tạo ra lịch sử không hợp lệ trong thử nghiệm của bản JS (chưa thử
  trên API thật).
- **Giữ bản tóm tắt cũ**: bản Python chỉ đưa 20 tin cuối của phần cũ vào yêu cầu tóm tắt, nên bản tóm tắt lần trước có thể bị bỏ sót.
- **Khi tóm tắt lỗi**: bản JS giữ nguyên lịch sử; bản Python thay phần cũ bằng một dòng `[Compacted N earlier messages]` (mất thông tin).
- **Cách đo**: bản JS dùng kích thước ngữ cảnh thật, gồm cả token lấy từ cache. Bản Python so ngưỡng với `input_tokens`; theo cách
  Anthropic tính, số này chỉ gồm phần sau điểm cache cuối cùng, nên khi bật prompt caching (mặc định) nó có thể nhỏ hơn rất nhiều so với
  kích thước thật và việc tóm tắt ít khi kích hoạt. (Suy ra từ code và cách API tính token, chưa kiểm chứng với API thật.)
- **Tuỳ chỉnh**: `--context-window` chỉnh được (bản Python cố định 200.000), và `/compact` tóm tắt thật (bản Python chỉ cắt bớt lịch sử).

**Giới hạn giống bản Python:** profile `Explore`/`Plan` vẫn có `Bash`, nên "chỉ đọc" dựa vào lời dặn trong prompt, không được code ép
buộc.

**Mới thêm:** `--mock`, `--show-payload`, và việc hỏi xác nhận trước Write/Edit/Bash.

## Trạng thái kiểm thử và lưu ý

- Đã chạy thử thủ công với `--mock` ở cả hai chế độ (một lần, tương tác qua pipe) và với sub-agent. Các tình huống biên (lỗi giữa
  chừng, huỷ bằng `AbortController`, lỗi trong sub-agent, từ chối quyền) và cơ chế tự tóm tắt (chỗ cắt giữ nguyên cặp công cụ, tóm tắt
  lần hai, lỗi hoặc huỷ khi đang tóm tắt, số đo token gồm cả cache, luồng đầy đủ trong chế độ tương tác) được kiểm tra bằng script tạm,
  **chưa có bộ test tự động kèm trong thư mục này**.
- **Chưa kiểm tra:** gọi API thật (chưa có API key khi viết) nên chưa biết chất lượng bản tóm tắt do model thật viết, và phím Ctrl+C
  thật trong terminal tương tác (mới thử huỷ bằng `AbortController`, chưa thử bằng tín hiệu từ bàn phím). Nếu gặp lỗi, hãy gửi lại
  thông báo.
- Khi agent đang chạy một lệnh `Bash`, Ctrl+C chỉ có tác dụng sau khi lệnh đó kết thúc (hàm chạy lệnh là đồng bộ).
- Một số model OpenAI mới yêu cầu tham số `max_completion_tokens` thay cho `max_tokens`. Nếu gặp lỗi về tham số này,
  đổi tên trường trong `buildBody` của `openaiProvider` (`src/providers.js`).
- Bản này gọi API kiểu không streaming: chữ chỉ hiện ra sau khi model trả lời xong cả lượt.
