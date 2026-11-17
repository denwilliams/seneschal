-- Generated with pi-durable 1.3.0 at harness base 985d6f1 using a faux model.
-- Completed turn, channel state, and an interrupted unsafe tool; no real data or credentials.
BEGIN TRANSACTION;
CREATE TABLE conversations (
			id INTEGER PRIMARY KEY,
			owner_conversation_id INTEGER,
			owner_task_id INTEGER,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT;
INSERT INTO "conversations" VALUES(1,NULL,NULL,'{"id":1}');
INSERT INTO "conversations" VALUES(11,NULL,NULL,'{"id":11,"parent":{"conversationId":1,"at":9}}');
CREATE TABLE document_revisions (
			document_id INTEGER NOT NULL,
			seq INTEGER NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
			version INTEGER NOT NULL,
			content TEXT NOT NULL CHECK (json_valid(content)),
			PRIMARY KEY (document_id, seq)
		) STRICT;
INSERT INTO "document_revisions" VALUES(2,1,'base',1,'{"channelId":"C1","workspace":"__WORKSPACE__","mainConversationId":0,"modelOverride":false,"blocked":[]}');
INSERT INTO "document_revisions" VALUES(3,2,'base',1,'{}');
INSERT INTO "document_revisions" VALUES(4,2,'base',1,'{"items":[]}');
INSERT INTO "document_revisions" VALUES(5,2,'base',1,'{"models":{},"tools":{}}');
INSERT INTO "document_revisions" VALUES(6,2,'base',1,'{"sessionId":"01a1abce-1936-7388-acb4-2044e3b3160a"}');
INSERT INTO "document_revisions" VALUES(7,2,'base',1,'{"model":{"provider":"fixture","modelId":"model"},"extensions":["slack-channel"],"tools":["mutation"],"cwd":"__WORKSPACE__"}');
INSERT INTO "document_revisions" VALUES(2,2,'delta',1,'[["s",["mainConversationId"],1]]');
INSERT INTO "document_revisions" VALUES(8,2,'base',1,'{"kind":"main","threadKey":""}');
INSERT INTO "document_revisions" VALUES(10,3,'base',1,'{"rev":1,"value":{"retained":"from 1.3.0"},"updatedAt":1793883773240,"updatedBy":{"source":"operator","threadKey":"","userId":""},"changes":[{"rev":1,"at":1793883773240,"op":"set","path":"/retained","source":"operator","threadKey":""}]}');
INSERT INTO "document_revisions" VALUES(12,4,'base',1,'{"model":{"provider":"fixture","modelId":"model"},"extensions":["slack-channel"],"tools":["mutation"],"cwd":"__WORKSPACE__"}');
INSERT INTO "document_revisions" VALUES(14,4,'base',1,'{"items":[]}');
INSERT INTO "document_revisions" VALUES(16,4,'base',1,'{"sessionId":"01a1abce-193b-7388-acb4-2047c55ed781"}');
INSERT INTO "document_revisions" VALUES(17,4,'base',1,'{"conversationId":11,"forkedFromEntry":9,"createdAt":1793883773243,"lastActivityAt":1793883773243,"resetCount":0,"pinnedModel":false,"admittedRequests":0}');
INSERT INTO "document_revisions" VALUES(18,4,'base',1,'{"kind":"thread","threadKey":"thread"}');
INSERT INTO "document_revisions" VALUES(19,5,'base',1,'{"hash":"735cc4f4f8e9eeb36a431a2209c7d9c3a3e9818275fdce24cc841e1052ccfad7","userId":"U1","threadKey":"thread","admitted":true}');
INSERT INTO "document_revisions" VALUES(17,5,'delta',1,'[["s",["lastActivityAt"],1793883773245],["s",["admittedRequests"],1]]');
INSERT INTO "document_revisions" VALUES(25,11,'base',1,'{"hash":"60db93e32a74c1a0f2b16b106946655711feae817070e2002c3cd02559258314","userId":"U1","threadKey":"thread","admitted":true}');
INSERT INTO "document_revisions" VALUES(17,11,'delta',1,'[["s",["lastActivityAt"],1793883773256],["s",["admittedRequests"],2]]');
INSERT INTO "document_revisions" VALUES(13,16,'base',1,'{"run":{"taskId":28,"inputs":[27]},"tools":[{"callId":"old-call","name":"mutation","taskId":30,"status":"pending"}]}');
INSERT INTO "document_revisions" VALUES(15,16,'base',1,'{"models":{"fixture/model":{"input":54,"output":6,"cacheRead":44,"cacheWrite":54,"totalTokens":158,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}},"tools":{}}');
INSERT INTO "document_revisions" VALUES(13,18,'delta',1,'[["s",["tools",0,"status"],"running"]]');
CREATE TABLE documents (
			id INTEGER PRIMARY KEY,
			kind TEXT NOT NULL,
			family INTEGER NOT NULL CHECK (family IN (0, 1)),
			key_value TEXT NOT NULL,
			scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
			owner_id INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			retired_at INTEGER,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT;
INSERT INTO "documents" VALUES(2,'"slack.host"',0,'""','session',0,1,NULL,'{"id":2,"kind":"slack.host","scope":{"kind":"session"},"createdAt":1}');
INSERT INTO "documents" VALUES(3,'"pi.live"',0,'""','conversation',1,2,NULL,'{"id":3,"kind":"pi.live","scope":{"kind":"conversation","conversationId":1},"history":"latest","fork":"initial","createdAt":2}');
INSERT INTO "documents" VALUES(4,'"pi.inbox"',0,'""','conversation',1,2,NULL,'{"id":4,"kind":"pi.inbox","scope":{"kind":"conversation","conversationId":1},"history":"latest","fork":"initial","createdAt":2}');
INSERT INTO "documents" VALUES(5,'"pi.usage"',0,'""','conversation',1,2,NULL,'{"id":5,"kind":"pi.usage","scope":{"kind":"conversation","conversationId":1},"history":"latest","fork":"initial","createdAt":2}');
INSERT INTO "documents" VALUES(6,'"pi.provider"',0,'""','conversation',1,2,NULL,'{"id":6,"kind":"pi.provider","scope":{"kind":"conversation","conversationId":1},"history":"latest","fork":"initial","createdAt":2}');
INSERT INTO "documents" VALUES(7,'"pi.agent"',0,'""','conversation',1,2,NULL,'{"id":7,"kind":"pi.agent","scope":{"kind":"conversation","conversationId":1},"history":"rewindable","fork":"asOf","createdAt":2}');
INSERT INTO "documents" VALUES(8,'"slack.route"',0,'""','conversation',1,2,NULL,'{"id":8,"kind":"slack.route","scope":{"kind":"conversation","conversationId":1},"history":"latest","fork":"initial","createdAt":2}');
INSERT INTO "documents" VALUES(10,'"slack.state"',0,'""','session',0,3,NULL,'{"id":10,"kind":"slack.state","scope":{"kind":"session"},"createdAt":3}');
INSERT INTO "documents" VALUES(12,'"pi.agent"',0,'""','conversation',11,4,NULL,'{"id":12,"kind":"pi.agent","scope":{"kind":"conversation","conversationId":11},"history":"rewindable","fork":"asOf","createdAt":4}');
INSERT INTO "documents" VALUES(13,'"pi.live"',0,'""','conversation',11,4,NULL,'{"id":13,"kind":"pi.live","scope":{"kind":"conversation","conversationId":11},"history":"latest","fork":"initial","createdAt":4}');
INSERT INTO "documents" VALUES(14,'"pi.inbox"',0,'""','conversation',11,4,NULL,'{"id":14,"kind":"pi.inbox","scope":{"kind":"conversation","conversationId":11},"history":"latest","fork":"initial","createdAt":4}');
INSERT INTO "documents" VALUES(15,'"pi.usage"',0,'""','conversation',11,4,NULL,'{"id":15,"kind":"pi.usage","scope":{"kind":"conversation","conversationId":11},"history":"latest","fork":"initial","createdAt":4}');
INSERT INTO "documents" VALUES(16,'"pi.provider"',0,'""','conversation',11,4,NULL,'{"id":16,"kind":"pi.provider","scope":{"kind":"conversation","conversationId":11},"history":"latest","fork":"initial","createdAt":4}');
INSERT INTO "documents" VALUES(17,'"slack.thread"',1,'"thread"','session',0,4,NULL,'{"id":17,"kind":"slack.thread","key":"thread","scope":{"kind":"session"},"createdAt":4}');
INSERT INTO "documents" VALUES(18,'"slack.route"',0,'""','conversation',11,4,NULL,'{"id":18,"kind":"slack.route","scope":{"kind":"conversation","conversationId":11},"history":"latest","fork":"initial","createdAt":4}');
INSERT INTO "documents" VALUES(19,'"slack.request"',1,'"old-complete"','conversation',11,5,NULL,'{"id":19,"kind":"slack.request","key":"old-complete","scope":{"kind":"conversation","conversationId":11},"history":"latest","fork":"initial","createdAt":5}');
INSERT INTO "documents" VALUES(25,'"slack.request"',1,'"old-pending"','conversation',11,11,NULL,'{"id":25,"kind":"slack.request","key":"old-pending","scope":{"kind":"conversation","conversationId":11},"history":"latest","fork":"initial","createdAt":11}');
CREATE TABLE durable_metadata (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			next_id TEXT NOT NULL,
			next_seq INTEGER NOT NULL
		) STRICT;
INSERT INTO "durable_metadata" VALUES(1,'31',19);
CREATE TABLE durable_schema (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		) STRICT;
INSERT INTO "durable_schema" VALUES(1,1);
CREATE TABLE entries (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			head INTEGER,
			commit_seq INTEGER NOT NULL,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT;
INSERT INTO "entries" VALUES(9,1,NULL,2,'{"kind":"slack.channel.root","model":[{"role":"user","content":"[channel C1: shared context begins here]","timestamp":1793883773239}],"id":9,"conversationId":1}');
INSERT INTO "entries" VALUES(20,11,NULL,6,'{"model":[{"role":"user","content":"old question","timestamp":1793883773245}],"kind":"pi.user","id":20,"conversationId":11}');
INSERT INTO "entries" VALUES(23,11,NULL,8,'{"model":[{"role":"system","content":"","toolsAdded":[{"name":"mutation","description":"Test mutation","parameters":{"type":"object","properties":{}}}],"timestamp":1793883773249}],"kind":"pi.system","id":23,"conversationId":11,"byTaskId":22}');
INSERT INTO "entries" VALUES(24,11,NULL,10,'{"model":[{"role":"assistant","content":[{"type":"text","text":"old answer"}],"api":"faux:1793883773227:lgowxhfbiv","provider":"fixture","model":"model","usage":{"input":44,"output":3,"cacheRead":0,"cacheWrite":44,"totalTokens":91,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1793883773242}],"kind":"pi.assistant","id":24,"conversationId":11,"byTaskId":22}');
INSERT INTO "entries" VALUES(26,11,NULL,12,'{"model":[{"role":"user","content":"do mutation","timestamp":1793883773257}],"kind":"pi.user","id":26,"conversationId":11}');
INSERT INTO "entries" VALUES(29,11,NULL,16,'{"model":[{"role":"assistant","content":[{"type":"toolCall","id":"old-call","name":"mutation","arguments":{}}],"api":"faux:1793883773227:lgowxhfbiv","provider":"fixture","model":"model","usage":{"input":10,"output":3,"cacheRead":44,"cacheWrite":10,"totalTokens":67,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1793883773242}],"kind":"pi.assistant","id":29,"conversationId":11,"byTaskId":28}');
CREATE TABLE record_ids (
			id INTEGER PRIMARY KEY,
			record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
		) STRICT;
INSERT INTO "record_ids" VALUES(1,'conversation');
INSERT INTO "record_ids" VALUES(2,'document');
INSERT INTO "record_ids" VALUES(3,'document');
INSERT INTO "record_ids" VALUES(4,'document');
INSERT INTO "record_ids" VALUES(5,'document');
INSERT INTO "record_ids" VALUES(6,'document');
INSERT INTO "record_ids" VALUES(7,'document');
INSERT INTO "record_ids" VALUES(8,'document');
INSERT INTO "record_ids" VALUES(9,'entry');
INSERT INTO "record_ids" VALUES(10,'document');
INSERT INTO "record_ids" VALUES(11,'conversation');
INSERT INTO "record_ids" VALUES(12,'document');
INSERT INTO "record_ids" VALUES(13,'document');
INSERT INTO "record_ids" VALUES(14,'document');
INSERT INTO "record_ids" VALUES(15,'document');
INSERT INTO "record_ids" VALUES(16,'document');
INSERT INTO "record_ids" VALUES(17,'document');
INSERT INTO "record_ids" VALUES(18,'document');
INSERT INTO "record_ids" VALUES(19,'document');
INSERT INTO "record_ids" VALUES(20,'entry');
INSERT INTO "record_ids" VALUES(21,'submission');
INSERT INTO "record_ids" VALUES(22,'task');
INSERT INTO "record_ids" VALUES(23,'entry');
INSERT INTO "record_ids" VALUES(24,'entry');
INSERT INTO "record_ids" VALUES(25,'document');
INSERT INTO "record_ids" VALUES(26,'entry');
INSERT INTO "record_ids" VALUES(27,'submission');
INSERT INTO "record_ids" VALUES(28,'task');
INSERT INTO "record_ids" VALUES(29,'entry');
INSERT INTO "record_ids" VALUES(30,'task');
CREATE TABLE submissions (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			request_id TEXT,
			status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT;
INSERT INTO "submissions" VALUES(21,11,'"old-complete"','done','{"conversationId":11,"requestId":"old-complete","type":"input","status":"done","entry":20,"id":21,"answer":24}');
INSERT INTO "submissions" VALUES(27,11,'"old-pending"','placed','{"conversationId":11,"requestId":"old-pending","type":"input","status":"placed","entry":26,"id":27}');
CREATE TABLE tasks (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
			abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
			background INTEGER NOT NULL CHECK (background IN (0, 1)),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT;
INSERT INTO "tasks" VALUES(22,11,'"pi.generation"','terminal',0,0,'{"id":22,"conversationId":11,"kind":"pi.generation","version":1,"input":{},"background":false,"abortRequested":false,"state":{"status":"terminal","outcome":{"status":"completed","result":{"entryId":24}}},"startedAt":1793883773247,"endedAt":1793883773254}');
INSERT INTO "tasks" VALUES(28,11,'"pi.generation"','waiting',0,0,'{"id":28,"conversationId":11,"kind":"pi.generation","version":1,"input":{},"background":false,"abortRequested":false,"state":{"status":"waiting","checkpoint":{"phase":"tools","assistant":29,"tools":[30],"pending":[]},"on":[30],"policy":"allSettled"},"startedAt":1793883773258}');
INSERT INTO "tasks" VALUES(30,11,'"pi.tool"','running',0,0,'{"id":30,"conversationId":11,"kind":"pi.tool","version":2,"input":{"kind":"model","assistant":29,"callId":"old-call"},"owner":28,"background":false,"abortRequested":false,"state":{"status":"running","checkpoint":{"phase":"execute","arguments":{},"replay":"unsafe"}},"startedAt":1793883773263}');
CREATE INDEX conversations_by_owner_conversation ON conversations (owner_conversation_id, id);
CREATE INDEX conversations_by_owner_task ON conversations (owner_task_id, id);
CREATE INDEX entries_by_conversation ON entries (conversation_id, id DESC);
CREATE INDEX entry_heads_by_conversation ON entries (conversation_id, id DESC) WHERE head IS NOT NULL;
CREATE INDEX tasks_by_status ON tasks (status, id);
CREATE INDEX tasks_by_conversation ON tasks (conversation_id, id);
CREATE INDEX tasks_by_kind ON tasks (kind, id);
CREATE INDEX tasks_by_abort_requested ON tasks (abort_requested, id);
CREATE INDEX tasks_by_background ON tasks (background, id);
CREATE INDEX submissions_by_request ON submissions (conversation_id, request_id);
CREATE INDEX submissions_by_conversation ON submissions (conversation_id, id);
CREATE INDEX submissions_by_status ON submissions (status, id);
CREATE INDEX documents_by_address
			ON documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at);
CREATE INDEX documents_by_scope ON documents (scope_kind, owner_id, id);
CREATE INDEX documents_by_scope_kind ON documents (scope_kind, owner_id, kind, id);
CREATE INDEX document_revisions_by_kind ON document_revisions (document_id, kind, seq DESC);
COMMIT;
