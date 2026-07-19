import json
import re
import logging
from typing import Dict, Any, TypedDict, List, Optional
from langchain_core.messages import SystemMessage, HumanMessage
from app.core.llm import get_llm
from app.core.workload import AdaptivePolicy

logger = logging.getLogger("app.core.agents")

# Track active LLM requests for monitoring
_active_request_count = 0
_request_id_counter = 0

# Define the graph state schema
class AgentState(TypedDict):
    question: str
    workload: str
    policy: Dict[str, Any]  # Serializable version of AdaptivePolicy
    plan: Optional[str]
    draft_answer: Optional[str]
    feedback: Optional[str]
    confidence_score: int
    final_answer: Optional[str]
    loop_count: int
    visited_nodes: List[str]

def extract_json(text: str) -> Dict[str, Any]:
    """
    Robust helper to extract JSON from LLM string output.
    Supports markdown code blocks and raw JSON text.
    """
    cleaned = text.strip()
    # Try finding json markdown block first
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, re.DOTALL)
    if match:
        cleaned = match.group(1)
    else:
        # Try finding the first '{' and last '}'
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1:
            cleaned = cleaned[start:end+1]
            
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse LLM response as JSON: {text}. Error: {e}")
        # Return fallback values
        return {
            "confidence_score": 50,
            "is_correct": False,
            "feedback": "Could not parse verification results from LLM. Assuming review needed."
        }

# --- AGENT FUNCTIONS ---

def planner_agent(state: AgentState) -> Dict[str, Any]:
    """
    Planner Agent Node:
    Breaks down complex questions into structured steps.
    """
    global _active_request_count, _request_id_counter
    
    _request_id_counter += 1
    _active_request_count += 1
    request_id = _request_id_counter
    
    logger.info(f"[REQ #{request_id}] Starting Planner Agent (active requests: {_active_request_count})")
    question = state["question"]
    
    prompt = (
        "You are the Planner Agent. Your job is to analyze the user's question and break it down "
        "into a logical plan with structured steps and sub-questions required to answer it thoroughly.\n"
        f"User Question: {question}\n\n"
        "Provide only the numbered list of steps as your plan. Keep it focused and clear."
    )
    
    visited = list(state.get("visited_nodes", []))
    visited.append("Planner Agent")
    
    try:
        llm = get_llm()
        messages = [
            SystemMessage(content="You are a meticulous Planning AI that breaks down complex requests into actionable steps."),
            HumanMessage(content=prompt)
        ]
        response = llm.invoke(messages)
        plan_output = response.content
        logger.info(f"[REQ #{request_id}] Planner Agent completed successfully")
    except Exception as e:
        logger.error(f"[REQ #{request_id}] Planner Agent error: {e}")
        # Graceful fallback: generate a default response plan
        plan_output = f"1. Analyze user request: '{question}'.\n2. Formulate final response based on general knowledge."
    finally:
        _active_request_count -= 1
        logger.debug(f"[REQ #{request_id}] Planner Agent finished (active requests: {_active_request_count})")
    
    return {
        "plan": plan_output,
        "visited_nodes": visited
    }

def research_agent(state: AgentState) -> Dict[str, Any]:
    """
    Research Agent Node:
    Generates a draft solution based on the user's question, the plan (if present),
    and any feedback from the Verifier Agent (if present).
    """
    global _active_request_count, _request_id_counter
    
    _request_id_counter += 1
    _active_request_count += 1
    request_id = _request_id_counter
    
    logger.info(f"[REQ #{request_id}] Starting Research Agent (active requests: {_active_request_count})")
    question = state["question"]
    plan = state.get("plan")
    feedback = state.get("feedback")
    policy = state["policy"]
    detail_level = policy.get("detail_level", "Standard response")
    
    system_prompt = (
        "You are the Research Agent. Your job is to write a comprehensive and high-quality "
        f"answer to the user's question, adjusting your writing detail level to match: '{detail_level}'.\n\n"
        "Rules:\n"
        f"- If Detail Level is 'Full explanation with examples', give a detailed answer with code/conceptual examples.\n"
        f"- If Detail Level is 'Concise explanation', keep the explanation brief and directly to the point.\n"
        f"- If Detail Level is 'Bullet points only', provide ONLY bullet points summarizing the answer.\n"
        f"- If Detail Level is 'Action items only', summarize the answer strictly as a list of actionable steps."
    )
    
    user_prompt = f"User Question: {question}\n"
    if plan:
        user_prompt += f"\nHere is a conceptual plan to guide your answer:\n{plan}\n"
    if feedback:
        user_prompt += f"\nA previous draft was checked and requires correction. Address this feedback in your revision:\nFeedback: {feedback}\n"
        if state.get("draft_answer"):
            user_prompt += f"\nPrevious Draft:\n{state['draft_answer']}\n"
            
    visited = list(state.get("visited_nodes", []))
    visited.append("Research Agent")
    
    try:
        llm = get_llm()
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt)
        ]
        response = llm.invoke(messages)
        draft_output = response.content
        logger.info(f"[REQ #{request_id}] Research Agent completed successfully")
    except Exception as e:
        logger.error(f"[REQ #{request_id}] Research Agent error: {e}")
        # Bubble up critical connection error so client gets clear feedback
        raise RuntimeError(f"Failed to generate response from AI backend. Please verify Ollama is active. Error: {str(e)}")
    finally:
        _active_request_count -= 1
        logger.debug(f"[REQ #{request_id}] Research Agent finished (active requests: {_active_request_count})")
    
    return {
        "draft_answer": draft_output,
        "visited_nodes": visited
    }

def verifier_agent(state: AgentState) -> Dict[str, Any]:
    """
    Verifier Agent Node:
    Assesses the accuracy of the draft answer and assigns a confidence score.
    Outputs feedback if the draft requires corrections.
    """
    global _active_request_count, _request_id_counter
    
    _request_id_counter += 1
    _active_request_count += 1
    request_id = _request_id_counter
    
    logger.info(f"[REQ #{request_id}] Starting Verifier Agent (active requests: {_active_request_count})")
    question = state["question"]
    draft_answer = state.get("draft_answer", "")
    policy = state["policy"]
    target_threshold = policy.get("confidence_threshold", 85)
    
    prompt = (
        "You are the Verifier Agent. Evaluate the accuracy, completeness, and correctness of the draft answer "
        "relative to the original question.\n\n"
        f"Original Question: {question}\n"
        f"Draft Answer: {draft_answer}\n\n"
        "You must respond ONLY with a JSON object. Do not include markdown around the JSON, just the raw JSON object. "
        "The JSON object must contain exactly three keys:\n"
        "- 'confidence_score': An integer from 0 to 100 showing how correct and accurate the answer is.\n"
        "- 'is_correct': A boolean (true or false) indicating if the answer meets quality standards and requires no further revision.\n"
        "- 'feedback': A detailed description of any mistakes, logical errors, or omissions that need fixing. Keep it empty ('') if is_correct is true.\n\n"
        "Example JSON Output:\n"
        "{\n"
        '  "confidence_score": 90,\n'
        '  "is_correct": true,\n'
        '  "feedback": ""\n'
        "}"
    )
    
    visited = list(state.get("visited_nodes", []))
    visited.append("Verifier Agent")
    
    try:
        llm = get_llm(temperature=0.0) # Lower temperature for QA tasks
        messages = [
            SystemMessage(content="You are a strict QA auditor who checks facts and details. You communicate exclusively via JSON."),
            HumanMessage(content=prompt)
        ]
        response = llm.invoke(messages)
        result_dict = extract_json(response.content)
        logger.info(f"[REQ #{request_id}] Verifier Agent completed successfully with confidence: {result_dict.get('confidence_score', 50)}")
    except Exception as e:
        logger.error(f"[REQ #{request_id}] Verifier Agent error: {e}")
        # Fall back to low confidence loop to try again or exit gracefully
        result_dict = {
            "confidence_score": 50,
            "is_correct": False,
            "feedback": f"Verifier encountered a request exception: {str(e)}"
        }
    finally:
        _active_request_count -= 1
        logger.debug(f"[REQ #{request_id}] Verifier Agent finished (active requests: {_active_request_count})")
    
    confidence = result_dict.get("confidence_score", 50)
    is_correct = result_dict.get("is_correct", False)
    feedback_text = result_dict.get("feedback", "")
    
    # If the LLM marks it as correct but confidence is low (or vice versa), align them logically
    if is_correct and confidence < target_threshold:
        is_correct = False
        if not feedback_text:
            feedback_text = f"Confidence score {confidence}% is below target threshold of {target_threshold}%."
            
    return {
        "confidence_score": confidence,
        "feedback": feedback_text if not is_correct else "",
        "visited_nodes": visited
    }

def summarizer_agent(state: AgentState) -> Dict[str, Any]:
    """
    Summarizer Agent Node:
    Compresses the draft answer into action items. Used primarily in OVERLOADED state.
    """
    global _active_request_count, _request_id_counter
    
    _request_id_counter += 1
    _active_request_count += 1
    request_id = _request_id_counter
    
    logger.info(f"[REQ #{request_id}] Starting Summarizer Agent (active requests: {_active_request_count})")
    draft_answer = state.get("draft_answer", "")
    
    prompt = (
        "You are the Summarizer Agent. The user is currently experiencing high cognitive workload. "
        "Your task is to take the following detailed answer and compress it into a list of "
        "extremely brief, actionable bullet points (Action Items). Avoid long paragraphs.\n\n"
        f"Detailed Answer:\n{draft_answer}\n\n"
        "Provide only the list of action items."
    )
    
    visited = list(state.get("visited_nodes", []))
    visited.append("Summarizer Agent")
    
    try:
        llm = get_llm()
        messages = [
            SystemMessage(content="You are an expert executive summarizer who condenses information into direct, punchy action items."),
            HumanMessage(content=prompt)
        ]
        response = llm.invoke(messages)
        final_output = response.content
        logger.info(f"[REQ #{request_id}] Summarizer Agent completed successfully")
    except Exception as e:
        logger.error(f"[REQ #{request_id}] Summarizer Agent error: {e}")
        # Graceful fallback: return original text
        final_output = f"Action Items:\n\n- {draft_answer}"
    finally:
        _active_request_count -= 1
        logger.debug(f"[REQ #{request_id}] Summarizer Agent finished (active requests: {_active_request_count})")
    
    return {
        "final_answer": final_output,
        "visited_nodes": visited
    }

def final_verification_agent(state: AgentState) -> Dict[str, Any]:
    """
    Final Verification Agent Node:
    Performs a final rigorous safety and quality verification check on the solver's revised answer.
    """
    global _active_request_count, _request_id_counter
    
    _request_id_counter += 1
    _active_request_count += 1
    request_id = _request_id_counter
    
    logger.info(f"[REQ #{request_id}] Starting Final Verification Agent (active requests: {_active_request_count})")
    question = state["question"]
    draft_answer = state.get("draft_answer", "")
    
    prompt = (
        "You are the Final Verification Agent. Your job is to review the refined draft answer "
        "and perform a final rigorous sanity check for factual correctness, logical coherence, "
        "accuracy, and readability.\n\n"
        f"Original Question: {question}\n"
        f"Refined Draft: {draft_answer}\n\n"
        "Provide your final audit comments and output the final polished, verified version of the answer. "
        "Do not include any debug labels, just output the final audited answer."
    )
    
    visited = list(state.get("visited_nodes", []))
    visited.append("Final Verification Agent")
    
    try:
        llm = get_llm(temperature=0.0) # Strictly zero temperature for validation
        messages = [
            SystemMessage(content="You are a senior auditor who performs the final quality assurance check on BCI adaptive agent output."),
            HumanMessage(content=prompt)
        ]
        response = llm.invoke(messages)
        final_output = response.content
        logger.info(f"[REQ #{request_id}] Final Verification Agent completed successfully")
    except Exception as e:
        logger.error(f"[REQ #{request_id}] Final Verification Agent error: {e}")
        # Graceful fallback: use the draft answer
        final_output = draft_answer
    finally:
        _active_request_count -= 1
        logger.debug(f"[REQ #{request_id}] Final Verification Agent finished (active requests: {_active_request_count})")
        
    return {
        "final_answer": final_output,
        "visited_nodes": visited
    }

