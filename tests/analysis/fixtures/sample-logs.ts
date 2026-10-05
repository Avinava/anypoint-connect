/**
 * Test fixtures — synthetic log samples modelled on CloudHub 2.0 output.
 * Each sample covers a distinct log entry type.
 */

/** JSON Logger block — multi-line structured entry (INFO) */
export const SAMPLE_JSON_LOGGER_INFO = `2026-03-12T08:09:58.765Z INFO [w1abc] JsonLogger event:c0ffee00-0000-4000-8000-000000000001 [MuleRuntime].uber.86186: [sample-orders-sapi-dev].put:\\\\sf-Invoice:application\\\\json:sample-orders-sapi-config.BLOCKING @5d035c54 - {
  "correlationId" : "c0ffee00-0000-4000-8000-000000000001",
  "message" : " create SF Invoice Flow Ended",
  "tracePoint" : "START",
  "priority" : "INFO",
  "elapsed" : 1348,
  "locationInfo" : {
    "lineInFile" : "733",
    "component" : "json-logger:logger",
    "fileName" : "interface.xml",
    "rootContainer" : "put:\\\\sf-Invoice:application\\\\json:sample-orders-sapi-config"
  },
  "timestamp" : "2026-03-12T08:09:58.765Z[UTC]",
  "content" : {
    "env" : "dev",
    "applicationName" : "sample-orders-sapi-dev",
    "flowName" : "put:\\\\sf-Invoice:application\\\\json:sample-orders-sapi-config",
    "status" : "Started",
    "timestamp" : "2026-03-12T08:09:58.76531172Z"
  },
  "applicationName" : "\${json.logger.application.name}",
  "applicationVersion" : "\${json.logger.application.version}",
  "environment" : "dev",
  "threadName" : "[MuleRuntime].uber.86186"
}`;

/** JSON Logger block — ERROR with Salesforce exception */
export const SAMPLE_JSON_LOGGER_ERROR = `2026-03-12T08:10:01.491Z ERROR [w1abc] JsonLogger event:c0ffee00-0000-4000-8000-000000000001 [MuleRuntime].uber.86211: [sample-orders-sapi-dev].sample-orders-sapi-main.BLOCKING @7126e15a - {
  "priority" : "ERROR",
  "correlationId" : "c0ffee00-0000-4000-8000-000000000001",
  "message" : "Error in Invoice creation",
  "errorType": "SALESFORCE_ACCESS_ERROR",
  "content" : {
    "errorCode" : "SALESFORCE_ACCESS_ERROR",
    "errorType" : "APP:SALESFORCE_ACCESS_ERROR",
    "flowName" : "create-sf-InvoiceFlow"
  },
  "Stacktrace__c": "We can't save this record because the Invoice process failed. FIELD_CUSTOM_VALIDATION_EXCEPTION."
}`;

/** HTTP listener DEBUG — raw network I/O (noise) */
export const SAMPLE_HTTP_DEBUG = `2026-03-12T08:09:58.652Z DEBUG [w1abc] sample-http-listener-config event:c0ffee00-0000-4000-8000-000000000002 http.listener.01 - [9ddf4975, L:/100.64.152.46:8081 - R:/100.64.168.136:36618] READ: 1015B POST /api/sobject/Credit_Memo_Line__c?_HttpMethod=PATCH HTTP/1.1
x-anypnt-app-worker: WORKER-SAMPLE-0001
x-correlation-id: c0ffee00-0000-4000-8000-000000000001
User-Agent: AHC/1.0
Accept: */*
Content-Type: application/json; charset=UTF-8`;

/** DefaultExceptionListener — Mule DSL error */
export const SAMPLE_EXCEPTION_LISTENER = `2026-03-12T08:10:01.49Z ERROR [w1abc] DefaultExceptionListener event:c0ffee00-0000-4000-8000-000000000001 [MuleRuntime].uber.86203: [sample-orders-sapi-dev].create-sf-InvoiceFlow.CPU_INTENSIVE @2ef6800 - 
Element DSL           : <raise-error doc:name="Raise error" doc:id="c0ffee00-0000-4000-8000-000000000003" type="APP:SALESFORCE_ACCESS_ERROR" description="#[(vars.errorVar.message) as String]"></raise-error>
Error type            : APP:SALESFORCE_ACCESS_ERROR`;

/** Scheduler WARN — task rejection */
export const SAMPLE_SCHEDULER_WARN = `2026-03-12T08:10:01.738Z WARN [w1abc] trace event:c0ffee00-0000-4000-8000-000000000002 http.listener.01 - Task rejected (AbortBusyPolicy ) from '[MuleRuntime].uber' scheduler: [sample-orders-sapi-dev].sample-orders-sapi-main.CPU_LITE @78a97ed3 - org.mule.runtime.core.internal.processor.strategy.PreservingThreadContextExecutorServiceWrapper$DecoratedCallable`;

/** Startup/Init INFO */
export const SAMPLE_STARTUP_INFO = `2026-03-12T07:01:58.056Z INFO [w2def] FlowConstructLifecycleManager event:00000000-0000-0000-0000-000000000000 WrapperListener_start_runner - Initialising flow: errorLogSalesforce`;

/**
 * Multi-entry sample with a full error context chain (same correlationId).
 * Simulates: flow start → processing → error → propagation.
 */
export const SAMPLE_ERROR_CONTEXT_CHAIN = `2026-03-12T08:09:57.413Z INFO [w1abc] JsonLogger event:c0ffee00-0000-4000-8000-000000000001 [MuleRuntime].uber.86186: [sample-orders-sapi-dev].put:\\\\sf-Invoice:application\\\\json:sample-orders-sapi-config.BLOCKING @5d035c54 - {
  "correlationId" : "c0ffee00-0000-4000-8000-000000000001",
  "message" : "put sf-Invoice flow started",
  "tracePoint" : "START",
  "elapsed" : 0,
  "content" : {
    "flowName" : "put:\\\\sf-Invoice:application\\\\json:sample-orders-sapi-config"
  }
}
2026-03-12T08:09:58.765Z INFO [w1abc] JsonLogger event:c0ffee00-0000-4000-8000-000000000001 [MuleRuntime].uber.86186: [sample-orders-sapi-dev].create-sf-InvoiceFlow.BLOCKING @c1f74a0 - {
  "correlationId" : "c0ffee00-0000-4000-8000-000000000001",
  "message" : "create SF Invoice Flow started",
  "tracePoint" : "START",
  "elapsed" : 1348,
  "content" : {
    "flowName" : "create-sf-InvoiceFlow"
  }
}
2026-03-12T08:10:01.489Z ERROR [w1abc] JsonLogger event:c0ffee00-0000-4000-8000-000000000001 [MuleRuntime].uber.86211: [sample-orders-sapi-dev].create-sf-InvoiceFlow.BLOCKING @c1f74a0 - {
  "correlationId" : "c0ffee00-0000-4000-8000-000000000001",
  "message" : "Error in Invoice creation",
  "priority" : "ERROR",
  "errorType" : "SALESFORCE_ACCESS_ERROR",
  "content" : {
    "flowName" : "create-sf-InvoiceFlow",
    "errorCode" : "SALESFORCE_ACCESS_ERROR"
  },
  "Stacktrace__c" : "FIELD_CUSTOM_VALIDATION_EXCEPTION: A filed project cannot be closed as Cancelled."
}
2026-03-12T08:10:01.491Z ERROR [w1abc] JsonLogger event:c0ffee00-0000-4000-8000-000000000001 [MuleRuntime].uber.86211: [sample-orders-sapi-dev].sample-orders-sapi-main.BLOCKING @7126e15a - {
  "correlationId" : "c0ffee00-0000-4000-8000-000000000001",
  "message" : "Error propagated to main flow",
  "priority" : "ERROR",
  "errorType" : "SALESFORCE_ACCESS_ERROR",
  "content" : {
    "flowName" : "sample-orders-sapi-main"
  }
}
2026-03-12T08:10:01.761Z ERROR [w1abc] ForwardingToListenerHandler event:c0ffee00-0000-4000-8000-000000000001 http.listener.02 - Exception caught`;

/** Mixed log with different levels for stats testing */
export const SAMPLE_MIXED_LEVELS = `2026-03-12T07:01:57.051Z INFO [w2def] AbstractLifecycleManager event:00000000-0000-0000-0000-000000000000 WrapperListener_start_runner - Initialising Bean: http-request-config
2026-03-12T07:01:58.056Z INFO [w2def] FlowConstructLifecycleManager event:00000000-0000-0000-0000-000000000000 WrapperListener_start_runner - Initialising flow: errorLogSalesforce
2026-03-12T08:09:58.652Z DEBUG [w1abc] sample-http-listener-config event:c0ffee00-0000-4000-8000-000000000002 http.listener.01 - [9ddf4975] READ: 1015B POST /api/sobject
2026-03-12T08:09:58.653Z DEBUG [w1abc] sample-http-listener-config event:c0ffee00-0000-4000-8000-000000000002 http.listener.01 - [9ddf4975] READ COMPLETE
2026-03-12T08:09:58.766Z DEBUG [w1abc] sample-http-listener-config event:c0ffee00-0000-4000-8000-000000000002 http.listener.01 - [c616882e] WRITE: 92B HTTP/1.1 201 Created
2026-03-12T08:10:01.738Z WARN [w1abc] trace event:c0ffee00-0000-4000-8000-000000000002 http.listener.01 - Task rejected (AbortBusyPolicy)
2026-03-12T08:10:01.489Z ERROR [w1abc] JsonLogger event:c0ffee00-0000-4000-8000-000000000001 [MuleRuntime].uber.86211: [sample-orders-sapi-dev].create-sf-InvoiceFlow.BLOCKING @c1f74a0 - {
  "correlationId" : "c0ffee00-0000-4000-8000-000000000001",
  "message" : "Error in Invoice creation",
  "errorType" : "SALESFORCE_ACCESS_ERROR",
  "content" : { "flowName" : "create-sf-InvoiceFlow" }
}
2026-03-12T08:10:01.761Z ERROR [w1abc] ForwardingToListenerHandler event:c0ffee00-0000-4000-8000-000000000002 http.listener.02 - Exception caught`;
