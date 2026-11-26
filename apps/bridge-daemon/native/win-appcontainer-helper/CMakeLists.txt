cmake_minimum_required(VERSION 3.20)
project(messiah_appcontainer_helper LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(messiah-appcontainer-helper main.cpp)
if(WIN32)
  target_link_libraries(messiah-appcontainer-helper PRIVATE userenv advapi32)
endif()
