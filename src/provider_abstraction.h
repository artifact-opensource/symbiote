// Provider abstraction types for the AVA/Symbiote runtime
// This header defines the normalized model-facing interface that all providers
// should implement internally before translation to backend-specific wire formats.

#ifndef PROVIDER_ABSTRACTION_H
#define PROVIDER_ABSTRACTION_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    AE_ROLE_SYSTEM = 0,
    AE_ROLE_USER = 1,
    AE_ROLE_ASSISTANT = 2,
    AE_ROLE_TOOL = 3,
} ae_role_t;

typedef enum {
    AE_BLOCK_TEXT = 0,
    AE_BLOCK_IMAGE = 1,
    AE_BLOCK_TOOL_USE = 2,
    AE_BLOCK_TOOL_RESULT = 3,
} ae_block_type_t;

typedef struct {
    const char* type;   /* "base64" or "url" */
    const char* media_type;
    const char* data;
    const char* url;
} ae_image_source_t;

typedef struct {
    ae_block_type_t type;
    const char* text;
    const char* id;
    const char* name;
    const char* input_json;
    const char* tool_use_id;
    const char* content;
    int is_error;
    ae_image_source_t image_source;
    int has_image_source;
} ae_content_block_t;

typedef struct {
    const char* id;
    const char* name;
    const char* input_json;
    const char* extra_json;
} ae_tool_call_t;

typedef struct {
    const char* name;
    const char* description;
    const char* parameters_json;
} ae_tool_def_t;

typedef struct {
    int input_tokens;
    int output_tokens;
    int cache_read_tokens;
    int cache_write_tokens;
    int has_cache_read_tokens;
    int has_cache_write_tokens;
} ae_usage_t;

typedef enum {
    AE_STREAM_TEXT_DELTA = 0,
    AE_STREAM_TOOL_USE_START = 1,
    AE_STREAM_TOOL_USE_DELTA = 2,
    AE_STREAM_TOOL_USE_END = 3,
    AE_STREAM_THINKING_DELTA = 4,
    AE_STREAM_USAGE = 5,
    AE_STREAM_DONE = 6,
} ae_stream_event_type_t;

typedef struct {
    ae_stream_event_type_t type;
    const char* text;
    const char* tool_id;
    const char* tool_name;
    const char* tool_input_json;
    const char* stop_reason;
    ae_usage_t usage;
    int has_usage;
    const char* extra_json;
} ae_stream_event_t;

typedef struct {
    const char* api_key;
    const char* base_url;
    const char* model;
    int max_tokens;
    double temperature;
    int timeout_ms;
    const char* system_prompt;
} ae_provider_config_t;

typedef struct ae_provider ae_provider_t;

typedef int (*ae_provider_stream_fn)(
    const ae_provider_t* provider,
    const ae_provider_config_t* config,
    const void* messages,
    size_t message_count,
    const ae_tool_def_t* tools,
    size_t tool_count,
    int (*on_event)(const ae_stream_event_t* event, void* user_data),
    void* user_data
);

struct ae_provider {
    const char* name;
    ae_provider_stream_fn stream;
    void* impl;
};

/* Helper constructors for callers that want a stable stack-friendly API. */
ae_usage_t ae_usage_make(int input_tokens, int output_tokens);
ae_provider_config_t ae_provider_config_make(const char* model);

#ifdef __cplusplus
}
#endif

#endif /* PROVIDER_ABSTRACTION_H */
